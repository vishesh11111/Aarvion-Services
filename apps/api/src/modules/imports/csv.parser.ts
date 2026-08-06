/**
 * CSV reading utilities.
 *
 * Everything here streams. A 200 MB export must never be read into a Buffer —
 * that is both an OOM and a trivial denial-of-service vector.
 *
 * Real-world tolerances baked in, because real exports are messy:
 *   • BOM stripping (Excel writes one and it corrupts the first header)
 *   • delimiter sniffing (comma, semicolon in European locales, tab)
 *   • ragged rows accepted rather than fatal — a short row is a row error, not
 *     a failed import
 *   • duplicate/blank headers disambiguated instead of silently overwriting
 */
import fs from 'node:fs';
import { parse, type Parser } from 'csv-parse';
import { BadRequestError, ErrorCode } from '../../lib/errors';

export type CsvRow = Record<string, string>;

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Sniffs the delimiter from the header line by picking the candidate that
 * yields the most columns. Beats assuming ',' — semicolon-delimited exports from
 * European Excel are extremely common and would otherwise import as one column.
 */
export const detectDelimiter = (headerLine: string): string => {
  let best = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    // Count only separators outside quoted sections.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i += 1) {
      const char = headerLine[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (!inQuotes && char === delimiter) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  return best;
};

/** Makes headers unique and non-empty so no column is silently lost. */
export const normalizeHeaders = (headers: string[]): string[] => {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const cleaned = header.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
    const base = cleaned.length > 0 ? cleaned.slice(0, 120) : `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
};

/** Reads the first `bytes` of a file — enough to sniff headers and samples. */
const readHead = async (path: string, bytes = 64 * 1024): Promise<string> => {
  const handle = await fs.promises.open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
};

export interface CsvPreview {
  headers: string[];
  rows: CsvRow[];
  delimiter: string;
  /** Rough estimate; exact count is only known after a full pass. */
  estimatedRows: number;
}

/**
 * Reads just enough of the file to drive the mapping UI: the header row and a
 * handful of sample rows. Never touches the rest of the file.
 */
export const previewCsv = async (path: string, sampleSize = 5): Promise<CsvPreview> => {
  const head = await readHead(path);
  if (head.trim().length === 0) {
    throw new BadRequestError('The uploaded file is empty', ErrorCode.INVALID_FILE);
  }

  const firstLine = head.split(/\r?\n/)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);

  const rows: CsvRow[] = [];
  let headers: string[] = [];

  await new Promise<void>((resolve) => {
    const parser = parse(head, {
      delimiter,
      bom: true,
      columns: (raw: string[]) => {
        headers = normalizeHeaders(raw);
        return headers;
      },
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      to: sampleSize + 1,
    });

    parser.on('readable', () => {
      let record: CsvRow | null;
      while ((record = parser.read() as CsvRow | null) !== null) {
        if (rows.length < sampleSize) rows.push(record);
      }
    });

    // We only read the first 64 KB, so the final record is usually a truncated
    // row and the parser may error on it. That is expected here: we already have
    // the headers and samples we came for, so every terminal event resolves and
    // the caller validates `headers` afterwards.
    parser.once('error', () => resolve());
    parser.once('end', () => resolve());
    parser.once('close', () => resolve());
  });

  if (headers.length === 0) {
    throw new BadRequestError(
      'Could not read a header row from this file. Ensure the first row contains column names.',
      ErrorCode.INVALID_FILE,
    );
  }
  if (headers.length > 200) {
    throw new BadRequestError('Files with more than 200 columns are not supported', ErrorCode.INVALID_FILE);
  }

  // Estimate total rows from the average line length in the sampled head.
  const { size } = await fs.promises.stat(path);
  const sampledLines = head.split(/\r?\n/).filter(Boolean).length;
  const averageLineBytes = sampledLines > 1 ? head.length / sampledLines : 100;
  const estimatedRows = Math.max(0, Math.round(size / averageLineBytes) - 1);

  return { headers, rows, delimiter, estimatedRows };
};

/**
 * Streams the whole file as parsed records.
 *
 * Returns the raw `csv-parse` stream so the worker can consume it with
 * `for await`, which gives natural backpressure: the file is only read as fast
 * as rows are written to the database.
 */
export const streamCsv = (path: string, delimiter: string): Parser =>
  fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 }).pipe(
    parse({
      delimiter,
      bom: true,
      columns: (raw: string[]) => normalizeHeaders(raw),
      skip_empty_lines: true,
      // Ragged rows are recorded as row errors by the worker; they must not
      // abort an otherwise-good 200k-row import.
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      skip_records_with_empty_values: false,
    }),
  );

/** Counts data rows without materialising them. Used to report accurate progress. */
export const countRows = async (path: string, delimiter: string): Promise<number> => {
  let count = 0;
  const parser = streamCsv(path, delimiter);
  for await (const _record of parser) {
    void _record;
    count += 1;
  }
  return count;
};
