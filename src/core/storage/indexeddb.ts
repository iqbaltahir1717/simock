// Local mockup library in IndexedDB. Metadata and file bytes live in separate stores so
// listing the library never loads the PSDs themselves.

import type { LibraryItem, LibraryStore } from './types';

const DB = 'simock-library';
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export class IndexedDbLibrary implements LibraryStore {
  readonly id = 'local' as const;
  private db?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, VERSION);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('items', { keyPath: 'id' });
          r.result.createObjectStore('files');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      this.db.catch(() => { this.db = undefined; });
    }
    return this.db;
  }

  async available(): Promise<boolean> {
    try {
      if (typeof indexedDB === 'undefined') return false;
      await this.open();
      // Ask the browser not to evict the library under storage pressure (best effort).
      await navigator.storage?.persist?.().catch(() => false);
      return true;
    } catch { return false; }
  }

  async list(): Promise<LibraryItem[]> {
    const db = await this.open();
    const items = await req(db.transaction('items').objectStore('items').getAll() as IDBRequest<LibraryItem[]>);
    return items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async getFile(id: string): Promise<ArrayBuffer | null> {
    const db = await this.open();
    return (await req(db.transaction('files').objectStore('files').get(id))) ?? null;
  }

  async put(item: LibraryItem, file: ArrayBuffer): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['items', 'files'], 'readwrite');
    tx.objectStore('items').put(item);
    tx.objectStore('files').put(file, item.id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Saving was aborted (storage full?).'));
    });
  }

  async update(id: string, patch: Partial<Omit<LibraryItem, 'id'>>): Promise<void> {
    const db = await this.open();
    const store = db.transaction('items', 'readwrite').objectStore('items');
    const cur = await req(store.get(id) as IDBRequest<LibraryItem | undefined>);
    if (cur) await req(store.put({ ...cur, ...patch, id }));
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['items', 'files'], 'readwrite');
    tx.objectStore('items').delete(id);
    tx.objectStore('files').delete(id);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }
}
