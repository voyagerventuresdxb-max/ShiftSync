import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  ApiError,
  eightySixItem,
  fetchEightySixList,
  markBackOn,
  type EightySixItemDto,
} from '../../api/eightySix';

interface Props {
  locationId: string;
}

/**
 * The 86 List — a real, shared, backend-persisted board of out-of-stock
 * items grouped by station. "Live" here means "backed by the database and
 * refetched on load/mutation," matching every other list in this app —
 * not real-time push (no websocket infra exists anywhere in this codebase).
 */
export default function EightySixBoard({ locationId }: Props) {
  const [items, setItems] = useState<EightySixItemDto[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [itemName, setItemName] = useState('');
  const [station, setStation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchEightySixList(locationId, showHistory)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the 86 list.'))
      .finally(() => setLoading(false));
  }, [locationId, showHistory]);

  useEffect(() => {
    load();
  }, [load]);

  const knownStations = useMemo(() => [...new Set(items.map((i) => i.station))].sort(), [items]);

  const grouped = useMemo(() => {
    const active = items.filter((i) => i.status === 'EIGHTY_SIXED');
    const byStation = new Map<string, EightySixItemDto[]>();
    for (const item of active) {
      const bucket = byStation.get(item.station) ?? [];
      bucket.push(item);
      byStation.set(item.station, bucket);
    }
    return [...byStation.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const resolved = useMemo(() => items.filter((i) => i.status === 'BACK_ON'), [items]);

  const handleAdd = useCallback(async () => {
    const trimmedName = itemName.trim();
    const trimmedStation = station.trim();
    if (!trimmedName || !trimmedStation) return;
    setSubmitting(true);
    setError(null);
    try {
      await eightySixItem({ locationId, itemName: trimmedName, station: trimmedStation });
      setItemName('');
      setStation('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not 86 this item.');
    } finally {
      setSubmitting(false);
    }
  }, [locationId, itemName, station, load]);

  const handleBackOn = useCallback(
    async (itemId: string) => {
      try {
        await markBackOn(itemId);
        load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not mark this item back on.');
      }
    },
    [load],
  );

  return (
    <section className="fp-86-board">
      <header className="fp-86-header">
        <div className="min-w-0">
          <p className="eyebrow">86 List</p>
          <h3>Out of stock, by station</h3>
        </div>
        <button className={cn('chip', showHistory && 'chip-active')} onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Hide history' : 'Show history'}
        </button>
      </header>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div className="fp-86-add">
        <input
          className="staff-directory-input"
          placeholder="Item (e.g. Wagyu striploin)"
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
        />
        <input
          className="staff-directory-input"
          list="fp-86-stations"
          placeholder="Station (e.g. Grill)"
          value={station}
          onChange={(e) => setStation(e.target.value)}
        />
        <datalist id="fp-86-stations">
          {knownStations.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button
          className="btn btn-primary"
          onClick={() => void handleAdd()}
          disabled={submitting || !itemName.trim() || !station.trim()}
        >
          <Plus className="h-4 w-4" /> 86 it
        </button>
      </div>

      {loading ? (
        <div className="status-block">
          <span className="spinner" aria-hidden />
          <p>Loading…</p>
        </div>
      ) : grouped.length === 0 ? (
        <p className="hint">Nothing 86'd right now.</p>
      ) : (
        <div className="fp-86-groups">
          {grouped.map(([stationName, stationItems]) => (
            <div key={stationName} className="fp-86-group">
              <p className="eyebrow">{stationName}</p>
              <ul className="space-y-1.5">
                {stationItems.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
                      <span className="truncate">{item.itemName}</span>
                    </span>
                    <button
                      onClick={() => void handleBackOn(item.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-success/30 px-2 py-1 text-xs font-medium text-success hover:bg-success/10"
                    >
                      <Check className="h-3 w-3" /> Back on
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {showHistory && (
        <div className="fp-86-history">
          <p className="eyebrow">Recently back on</p>
          {resolved.length === 0 ? (
            <p className="hint">Nothing resolved yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {resolved.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                  <span className="truncate">{item.itemName} — {item.station}</span>
                  <span className="shrink-0 tabular-nums">back on {new Date(item.backOnAt!).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
