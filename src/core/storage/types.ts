// Mockup library storage contract. Local (IndexedDB) now; Google Drive later behind the same interface.

export interface LibraryItem {
  /** SHA-256 of the file; also the key for saved template configuration. */
  id: string;
  name: string;
  size: number;
  width: number;
  height: number;
  addedAt: number;
  lastUsedAt: number;
  /** Small PNG preview (longest side ≤ 320px). */
  thumbnail?: Blob;
  category?: string;
}

export interface LibraryStore {
  readonly id: 'local' | 'drive';
  /** False when the environment blocks storage (e.g. the bundled plugin UI has a null origin). */
  available(): Promise<boolean>;
  list(): Promise<LibraryItem[]>;
  getFile(id: string): Promise<ArrayBuffer | null>;
  put(item: LibraryItem, file: ArrayBuffer): Promise<void>;
  update(id: string, patch: Partial<Omit<LibraryItem, 'id'>>): Promise<void>;
  remove(id: string): Promise<void>;
}
