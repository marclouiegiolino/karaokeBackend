import { createHash, createHmac } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { formatUrl } from '@aws-sdk/core/util';
import { HttpRequest, extendedEncodeURIComponent } from '@smithy/core/protocols';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import type { Configuration } from '../../Main/Configuration.js';
import type { IFileStorage, ObjectInfo } from './IFileStorage.js';
import { AppError } from '../../Utils/AppError.js';

type HashSource = string | ArrayBuffer | ArrayBufferView;
const PUT_SIGNABLE_HEADERS = new Set(['content-type']);
const SAFE_S3_KEY_RE = /^[A-Za-z0-9_.~/-]+$/;
const stringHmacCache = new Map<string, Uint8Array>();

function toUint8(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function encodeS3Key(key: string): string {
  return SAFE_S3_KEY_RE.test(key) ? key : key.split('/').map(extendedEncodeURIComponent).join('/');
}

// Use synchronous BoringSSL hashes under nodejs_compat instead of multi-promise WebCrypto HMAC hops.
class NodeCryptoSha256 {
  private hash?: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  private readonly secret?: string | Uint8Array;
  private cachedResult?: Uint8Array;

  constructor(secret?: HashSource) {
    if (secret !== undefined) {
      this.secret = typeof secret === 'string' ? secret : toUint8(secret);
    }
  }

  update(chunk: HashSource, encoding?: 'utf8' | 'ascii' | 'latin1') {
    if (!this.hash && this.cachedResult === undefined && typeof this.secret === 'string') {
      const chunkKey =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(
              ArrayBuffer.isView(chunk) ? chunk.buffer : chunk,
              ArrayBuffer.isView(chunk) ? chunk.byteOffset : 0,
              ArrayBuffer.isView(chunk) ? chunk.byteLength : chunk.byteLength,
            ).toString('latin1');
      const cacheKey = `${this.secret}\0${chunkKey}`;
      let hit = stringHmacCache.get(cacheKey);
      if (!hit) {
        const h = createHmac('sha256', this.secret);
        if (typeof chunk === 'string') h.update(chunk, encoding ?? 'utf8');
        else h.update(toUint8(chunk));
        hit = h.digest();
        if (stringHmacCache.size >= 16) stringHmacCache.clear();
        stringHmacCache.set(cacheKey, hit);
      }
      this.cachedResult = hit;
      return;
    }
    if (!this.hash) {
      this.hash =
        this.secret !== undefined ? createHmac('sha256', this.secret) : createHash('sha256');
      if (this.cachedResult !== undefined) {
        this.cachedResult = undefined;
      }
    }
    if (typeof chunk === 'string') {
      this.hash.update(chunk, encoding ?? 'utf8');
    } else {
      this.hash.update(toUint8(chunk));
    }
  }

  digest() {
    if (this.cachedResult !== undefined) {
      return Promise.resolve(this.cachedResult);
    }
    const h =
      this.hash ??
      (this.secret !== undefined ? createHmac('sha256', this.secret) : createHash('sha256'));
    return Promise.resolve(h.digest());
  }

  reset() {
    this.hash = undefined;
    this.cachedResult = undefined;
  }
}

export class R2FileStorage implements IFileStorage {
  private client?: S3Client;
  private presigner?: S3RequestPresigner;
  private hostname?: string;
  private bucketPathPrefix?: string;
  private warmupFetch?: typeof fetch;
  constructor(
    private config: Configuration,
    private fetchImpl: typeof fetch = fetch,
    private mediaBucket?: R2Bucket,
  ) {}
  private get s3() {
    const c = this.config;
    if (!c.R2_ACCOUNT_ID || !c.R2_BUCKET || !c.R2_ACCESS_KEY_ID || !c.R2_SECRET_ACCESS_KEY)
      throw new AppError(503, 'STORAGE_UNCONFIGURED', 'Configure R2 before using media endpoints');
    if (this.client) return this.client;
    const baseOrigin = `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const authProperties = {
      authSchemes: [
        {
          name: 'sigv4' as const,
          signingName: 's3',
          signingRegion: 'auto',
          disableDoubleEncoding: true,
          properties: {},
        },
      ],
    };
    const bucketEndpoint = {
      url: new URL(`${baseOrigin}/${encodeURIComponent(c.R2_BUCKET)}`),
      properties: authProperties,
      headers: {},
    };
    const rootEndpoint = {
      url: new URL(baseOrigin),
      properties: authProperties,
      headers: {},
    };
    return (this.client = new S3Client({
      region: 'auto',
      cacheMiddleware: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      ignoreConfiguredEndpointUrls: true,
      forcePathStyle: true,
      sha256: NodeCryptoSha256,
      endpointProvider: (params: { Bucket?: string }) =>
        params.Bucket === c.R2_BUCKET
          ? bucketEndpoint
          : params.Bucket
            ? {
                url: new URL(`${baseOrigin}/${encodeURIComponent(String(params.Bucket))}`),
                properties: authProperties,
                headers: {},
              }
            : rootEndpoint,
      credentials: {
        accessKeyId: c.R2_ACCESS_KEY_ID,
        secretAccessKey: c.R2_SECRET_ACCESS_KEY,
      },
      requestHandler: new FetchHttpHandler({
        requestTimeout: 30000,
        customFetch: (input: RequestInfo | URL, init?: RequestInit) =>
          (this.warmupFetch ?? this.fetchImpl)(input, init),
        // Compressible R2 HEAD responses can omit Content-Length. Preserve byte metadata.
        requestInit: (request) => ({
          headers: { ...request.headers, 'accept-encoding': 'identity' },
        }),
      }),
      maxAttempts: 2,
    }));
  }
  private getPresigner() {
    const c = this.config;
    if (!c.R2_ACCOUNT_ID || !c.R2_BUCKET || !c.R2_ACCESS_KEY_ID || !c.R2_SECRET_ACCESS_KEY)
      throw new AppError(503, 'STORAGE_UNCONFIGURED', 'Configure R2 before using media endpoints');
    if (this.presigner) return this.presigner;
    this.hostname = `${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.bucketPathPrefix = `/${encodeURIComponent(c.R2_BUCKET)}/`;
    return (this.presigner = new S3RequestPresigner({
      region: 'auto',
      credentials: {
        accessKeyId: c.R2_ACCESS_KEY_ID,
        secretAccessKey: c.R2_SECRET_ACCESS_KEY,
      },
      sha256: NodeCryptoSha256,
      signingName: 's3',
      uriEscapePath: false,
      applyChecksum: false,
    }));
  }
  async prewarm() {
    const c = this.config;
    if (!c.R2_ACCOUNT_ID || !c.R2_BUCKET || !c.R2_ACCESS_KEY_ID || !c.R2_SECRET_ACCESS_KEY) return;
    const origAbortTimeout = AbortSignal.timeout;
    try {
      AbortSignal.timeout = () => new AbortController().signal;
      this.warmupFetch = (async () => ({
        ok: true,
        status: 200,
        text: async () =>
          '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"w"</ETag><LastModified>1970-01-01T00:00:00.000Z</LastModified></CopyObjectResult>',
      })) as unknown as typeof fetch;

      await this.uploadUrl('_staging/w', 'application/json', 1);
      await this.downloadUrl('songs/w');
      await this.promote('_staging/w', 'songs/w', '"w"', 'application/json');
    } finally {
      this.warmupFetch = undefined;
      AbortSignal.timeout = origAbortTimeout;
    }
  }
  async uploadUrl(key: string, contentType: string, byteSize: number) {
    const presigner = this.getPresigner();
    const hostname = this.hostname!;
    const req = new HttpRequest({
      protocol: 'https:',
      hostname,
      method: 'PUT',
      path: `${this.bucketPathPrefix!}${encodeS3Key(key)}`,
      query: { 'x-id': 'PutObject' },
      headers: {
        'content-type': contentType,
        'content-length': String(byteSize),
        host: hostname,
      },
    });
    const presigned = await presigner.presign(req, {
      expiresIn: 300,
      signableHeaders: PUT_SIGNABLE_HEADERS,
      signingRegion: 'auto',
      signingService: 's3',
    });
    return formatUrl(presigned);
  }
  async downloadUrl(key: string) {
    const presigner = this.getPresigner();
    const hostname = this.hostname!;
    const req = new HttpRequest({
      protocol: 'https:',
      hostname,
      method: 'GET',
      path: `${this.bucketPathPrefix!}${encodeS3Key(key)}`,
      query: { 'x-id': 'GetObject' },
      headers: {
        host: hostname,
        'x-amz-checksum-mode': 'ENABLED',
      },
    });
    const presigned = await presigner.presign(req, {
      expiresIn: 900,
      signingRegion: 'auto',
      signingService: 's3',
    });
    return formatUrl(presigned);
  }
  async head(key: string) {
    if (this.mediaBucket) {
      const h = await this.mediaBucket.head(key);
      if (!h) throw new Error('R2 object not found');
      if (!h.httpEtag)
        throw new AppError(502, 'STORAGE_METADATA_UNAVAILABLE', 'Object ETag is unavailable');
      return {
        byteSize: h.size,
        contentType: h.httpMetadata?.contentType ?? '',
        etag: h.httpEtag,
        sizeSource: 'head' as const,
        contentEncoding: h.httpMetadata?.contentEncoding ?? null,
      };
    }
    const h = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key }),
    );
    if (!h.ETag)
      throw new AppError(502, 'STORAGE_METADATA_UNAVAILABLE', 'Object ETag is unavailable');
    let byteSize = h.ContentLength;
    let sizeSource: 'head' | 'range' = 'head';
    if (byteSize === undefined) {
      // Unknown size is not zero. Fetch only one byte and read the total from Content-Range.
      const ranged = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.config.R2_BUCKET,
          Key: key,
          Range: 'bytes=0-0',
          IfMatch: h.ETag,
        }),
      );
      const match = /^bytes 0-0\/(\d+)$/.exec(ranged.ContentRange ?? '');
      const total = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(total) || total < 1 || !ranged.Body) {
        await ranged.Body?.transformToWebStream().cancel();
        throw new AppError(
          502,
          'STORAGE_METADATA_UNAVAILABLE',
          'Object size could not be verified from HEAD or a byte range',
        );
      }
      const sample = await ranged.Body.transformToByteArray();
      if (sample.length !== 1)
        throw new AppError(
          502,
          'STORAGE_METADATA_UNAVAILABLE',
          'Object range response was inconsistent',
        );
      byteSize = total;
      sizeSource = 'range';
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new AppError(502, 'STORAGE_METADATA_UNAVAILABLE', 'Object size is invalid');
    }
    return {
      byteSize,
      contentType: h.ContentType ?? '',
      etag: h.ETag,
      sizeSource,
      contentEncoding: h.ContentEncoding ?? null,
    };
  }
  async read(key: string, maxBytes: number, known?: ObjectInfo) {
    const h = known ?? (await this.head(key));
    if (h.byteSize > maxBytes)
      throw new AppError(400, 'ASSET_TOO_LARGE', 'Asset exceeds validation limit');
    if (this.mediaBucket) {
      const r = await this.mediaBucket.get(key, {
        onlyIf: { etagMatches: unquoteEtag(h.etag) },
      });
      if (!r || !('body' in r)) throw new Error('R2 object changed during validation');
      const bytes = await r.bytes();
      if (bytes.byteLength !== h.byteSize || bytes.byteLength > maxBytes)
        throw new AppError(502, 'STORAGE_METADATA_UNAVAILABLE', 'Object size changed during read');
      return bytes;
    }
    const r = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.R2_BUCKET,
        Key: key,
        IfMatch: h.etag,
      }),
    );
    return await r.Body!.transformToByteArray();
  }
  async prefix(key: string, bytes: number, etag?: string) {
    if (this.mediaBucket) {
      const r = await this.mediaBucket.get(key, {
        range: { offset: 0, length: bytes },
        ...(etag ? { onlyIf: { etagMatches: unquoteEtag(etag) } } : {}),
      });
      if (!r || !('body' in r)) throw new Error('R2 object changed during validation');
      return r.bytes();
    }
    const r = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.R2_BUCKET,
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
        IfMatch: etag,
      }),
    );
    return await r.Body!.transformToByteArray();
  }
  async promote(source: string, destination: string, etag: string, contentType?: string) {
    const type = contentType ?? (await this.head(source)).contentType;
    const presigner = this.getPresigner() as unknown as {
      signer: {
        sign(
          req: HttpRequest,
          opts: { signingRegion: string; signingService: string },
        ): Promise<HttpRequest>;
      };
    };
    const hostname = this.hostname!;
    const path = `${this.bucketPathPrefix!}${encodeS3Key(destination)}`;
    const signed = await presigner.signer.sign(
      new HttpRequest({
        protocol: 'https:',
        hostname,
        method: 'PUT',
        path,
        query: { 'x-id': 'CopyObject' },
        headers: {
          'content-type': type,
          'x-amz-copy-source': `${this.config.R2_BUCKET!}/${source}`,
          'x-amz-copy-source-if-match': etag,
          'cache-control': 'private, max-age=86400',
          'x-amz-metadata-directive': 'REPLACE',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'accept-encoding': 'identity',
          host: hostname,
        },
      }),
      { signingRegion: 'auto', signingService: 's3' },
    );
    const response = await (this.warmupFetch ?? this.fetchImpl)(
      `https://${hostname}${path}?x-id=CopyObject`,
      {
        method: 'PUT',
        headers: signed.headers,
        signal: AbortSignal.timeout(30000),
      },
    );
    const xml = await response.text();
    if (!response.ok || (!xml.includes('<CopyObjectResult') && xml.includes('<Error>'))) {
      const codeMatch = /<Code>\s*([^<\s]+)\s*<\/Code>/.exec(xml);
      const msgMatch = /<Message>\s*([^<]*?)\s*<\/Message>/.exec(xml);
      const err = new Error(msgMatch?.[1] || `R2 CopyObject failed (${response.status})`);
      err.name =
        codeMatch?.[1] || (response.status === 412 ? 'PreconditionFailed' : 'S3ServiceException');
      throw err;
    }
  }
  async remove(key: string) {
    if (this.mediaBucket) return this.mediaBucket.delete(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.R2_BUCKET, Key: key }));
  }
}

function unquoteEtag(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}
