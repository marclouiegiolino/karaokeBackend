export interface ObjectInfo {
  byteSize: number;
  contentType: string;
  etag: string;
  sizeSource?: 'head' | 'range';
  contentEncoding?: string | null;
}
export interface IFileStorage {
  uploadUrl(key: string, contentType: string, byteSize: number): Promise<string>;
  downloadUrl(key: string): Promise<string>;
  head(key: string): Promise<ObjectInfo>;
  read(key: string, maxBytes: number, known?: ObjectInfo): Promise<Uint8Array>;
  prefix(key: string, bytes: number, etag?: string): Promise<Uint8Array>;
  promote(source: string, destination: string, etag: string, contentType?: string): Promise<void>;
  remove(key: string): Promise<void>;
}
