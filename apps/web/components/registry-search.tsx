"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { RegistryHit } from "@agentbox/core/toolchain";
import { searchMiseTools } from "@/app/registry-actions";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 200;

/**
 * Search box over the mise registry (name and alias prefix, then substring). Picking a result calls
 * `onPick` and clears the box. Ids in `exclude` are shown as already added and cannot be picked.
 */
export function RegistrySearch({
  onPick,
  exclude,
  disabled,
  label = "Search more tools from the mise registry",
}: {
  onPick: (hit: RegistryHit) => void;
  exclude: readonly string[];
  disabled?: boolean;
  label?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (q.length === 0) {
      setHits([]);
      setFailed(false);
      return;
    }
    const timer = setTimeout(() => {
      searchMiseTools(q)
        .then((res) => {
          if (seq.current !== mine) return;
          setHits(res);
          setActive(0);
          setFailed(false);
        })
        .catch(() => {
          if (seq.current === mine) setFailed(true);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const pick = (hit: RegistryHit) => {
    if (exclude.includes(hit.id)) return;
    onPick(hit);
    setQuery("");
    setHits([]);
    setOpen(false);
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="relative space-y-1.5">
      <label className="text-sm font-medium" htmlFor={`${listId}-input`}>
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search by name, for example ripgrep, terraform or deno"
          className="pl-9"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && hits.length > 0) {
              e.preventDefault();
              setActive((a) => (a + 1) % hits.length);
            } else if (e.key === "ArrowUp" && hits.length > 0) {
              e.preventDefault();
              setActive((a) => (a - 1 + hits.length) % hits.length);
            } else if (e.key === "Enter" && showList && hits[active]) {
              e.preventDefault();
              pick(hits[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-card py-1"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground" role="presentation">
              {failed ? "Search failed. Try again." : "No matching tool."}
            </li>
          ) : (
            hits.map((hit, i) => {
              const added = exclude.includes(hit.id);
              return (
                <li
                  key={hit.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={added}
                  // mousedown (not click) so the input's blur does not close the list first
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(hit);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex cursor-pointer flex-col gap-0.5 px-3 py-2",
                    i === active && "bg-accent",
                    added && "cursor-default opacity-50",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{hit.name}</span>
                    {added ? (
                      <Badge variant="status">Added</Badge>
                    ) : (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {hit.backend}
                      </span>
                    )}
                  </span>
                  {hit.description ? (
                    <span className="truncate text-meta text-muted-foreground">
                      {hit.description}
                    </span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
