import { useEffect, useMemo, useState } from 'react';
import type { LibraryItem } from '../core/storage/types';

interface Props {
  available: boolean | null;
  items: LibraryItem[];
  activeId?: string;
  hasTemplate: (id: string) => boolean;
  onOpen: (item: LibraryItem) => void;
  onRemove: (item: LibraryItem) => void;
}

/** Saved mockups, most recently used first. Thumbnails come from the stored metadata, not the PSDs. */
export function Library({ available, items, activeId, hasTemplate, onOpen, onRemove }: Props) {
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const urls = useMemo(() => new Map(items.map((i) => [i.id, i.thumbnail ? URL.createObjectURL(i.thumbnail) : ''])), [items]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);

  if (available === false) return <p className="muted small">The library needs the hosted plugin UI to save mockups. For now, drop a PSD each time.</p>;
  if (!items.length) return null;
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;

  return (
    <div className="library">
      {items.length > 4 && <input className="search" placeholder="Search mockups" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className="grid">
        {shown.map((i) => (
          <div key={i.id} className={i.id === activeId ? 'tile on' : 'tile'} title={i.name}>
            <button className="thumb" onClick={() => onOpen(i)}>{urls.get(i.id) ? <img src={urls.get(i.id)} alt="" /> : <span>PSD</span>}</button>
            <div className="meta">
              <span className="name">{i.name.replace(/\.(psd|psb)$/i, '')}</span>
              <span className="muted">{i.width}×{i.height}{hasTemplate(i.id) ? ' · template' : ''}</span>
            </div>
            <button className="link danger" onClick={() => (confirming === i.id ? (onRemove(i), setConfirming(null)) : setConfirming(i.id))}>{confirming === i.id ? 'Confirm delete' : 'Delete'}</button>
          </div>
        ))}
      </div>
      {q && !shown.length && <p className="muted small">No mockups match “{query}”.</p>}
    </div>
  );
}
