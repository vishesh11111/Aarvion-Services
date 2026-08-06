/**
 * Streaming multipart upload handler (busboy).
 *
 * Why not multer: we only ever accept one CSV, and we want the bytes to go
 * straight to disk with a hard byte ceiling enforced *during* the stream. Doing
 * it directly is ~80 lines, has no transitive dependency surface, and makes the
 * failure modes explicit.
 *
 * Safety properties:
 *   • the generated storage key is a UUID — the client-supplied filename never
 *     touches the filesystem, so `../../etc/passwd` is structurally impossible;
 *   • the size limit is enforced by busboy as bytes arrive, not after the fact;
 *   • a rejected or aborted upload always unlinks its partial file.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import {
  BadRequestError,
  ErrorCode,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '../lib/errors';
import { createLogger } from '../lib/logger';

const log = createLogger('upload');

const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.txt'];
const ACCEPTED_MIME_PREFIXES = [
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/csv',
  'application/vnd.ms-excel', // what Windows/Excel actually sends for a .csv
  'application/octet-stream', // some browsers give up and send this
];

export const ensureUploadDir = async (): Promise<void> => {
  await fsp.mkdir(env.UPLOAD_DIR, { recursive: true });
};

const isAcceptable = (filename: string, mimeType: string): boolean => {
  const ext = path.extname(filename).toLowerCase();
  const extOk = ACCEPTED_EXTENSIONS.includes(ext);
  const mimeOk = ACCEPTED_MIME_PREFIXES.some((m) => mimeType.startsWith(m));
  // Extension is authoritative — browser MIME detection is famously unreliable,
  // and the parser will reject the content anyway if it is not really CSV.
  return extOk && mimeOk;
};

/**
 * Accepts exactly one file field named `file`, plus any simple text fields
 * (which land on `req.body`). Populates `req.uploadedFile`.
 */
export const singleFileUpload = (fieldName = 'file') =>
  async function uploadMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.is('multipart/form-data')) {
      next(new BadRequestError('Expected multipart/form-data', ErrorCode.UNSUPPORTED_MEDIA_TYPE));
      return;
    }

    await ensureUploadDir();

    const bb = busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: env.MAX_UPLOAD_BYTES,
        fields: 20,
        fieldSize: 1024 * 100,
      },
    });

    const fields: Record<string, string> = {};
    let storageKey: string | undefined;
    let settled = false;
    let bytesWritten = 0;
    /**
     * Resolves when the file has been fully written to disk.
     *
     * busboy emits `close` as soon as it has finished *parsing* the multipart
     * body, which happens before the write stream has flushed. Without awaiting
     * this, `close` runs while `req.uploadedFile` is still unset and every
     * upload fails with "missing file field" — a race that is invisible on a
     * fast local disk and reliable under any real I/O latency.
     */
    let writeComplete: Promise<void> | undefined;

    /** Guarantees we neither double-respond nor leak a half-written temp file. */
    const finish = async (error?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      if (error && storageKey) {
        await fsp.unlink(storageKey).catch(() => undefined);
      }
      req.unpipe(bb);
      if (error) next(error);
      else next();
    };

    bb.on('field', (name, value) => {
      if (name.length <= 64) fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== fieldName) {
        stream.resume(); // drain and ignore unexpected file fields
        return;
      }

      const originalName = path.basename(info.filename ?? 'upload.csv').slice(0, 200);

      if (!isAcceptable(originalName, info.mimeType ?? '')) {
        stream.resume();
        void finish(new UnsupportedMediaTypeError(ACCEPTED_EXTENSIONS));
        return;
      }

      const key = path.join(env.UPLOAD_DIR, `${randomUUID()}${path.extname(originalName).toLowerCase()}`);
      storageKey = key;

      stream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      stream.on('limit', () => {
        void finish(new PayloadTooLargeError(env.MAX_UPLOAD_BYTES));
      });

      const dest = fs.createWriteStream(key, { flags: 'wx', mode: 0o640 });

      writeComplete = pipeline(stream, dest).then(() => {
        if (settled) return;
        req.uploadedFile = {
          originalName,
          storageKey: key,
          sizeBytes: bytesWritten,
          mimeType: info.mimeType ?? 'text/csv',
        };
      });
    });

    bb.on('filesLimit', () => void finish(new BadRequestError('Only one file may be uploaded at a time')));
    bb.on('error', (err) => void finish(err as Error));

    bb.on('close', () => {
      void (async () => {
        if (settled) return;

        // Wait for the bytes to actually reach disk before deciding whether the
        // upload succeeded — see the note on `writeComplete` above.
        try {
          await writeComplete;
        } catch (error) {
          log.error({ err: (error as Error).message }, 'failed writing upload to disk');
          await finish(error as Error);
          return;
        }

        if (!req.uploadedFile) {
          await finish(
            new BadRequestError(`Missing required file field "${fieldName}"`, ErrorCode.INVALID_FILE),
          );
          return;
        }

        req.body = { ...(req.body ?? {}), ...fields };
        await finish();
      })();
    });

    // Client hung up mid-upload: clean up the partial file.
    res.on('close', () => {
      if (!settled && storageKey) void fsp.unlink(storageKey).catch(() => undefined);
    });

    req.pipe(bb);
  };

/** Deletes an uploaded file. Safe to call with an already-removed path. */
export const discardUpload = async (storageKey: string): Promise<void> => {
  await fsp.unlink(storageKey).catch(() => undefined);
};
