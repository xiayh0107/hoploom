import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {HostRow} from './hostInventory';

const overscan = 8;
function lowerBound(offsets: number[], value: number) {
  let low = 0, high = offsets.length - 1;
  while (low < high) {const middle = (low + high) >>> 1; if (offsets[middle] < value) low = middle + 1; else high = middle;}
  return low;
}

/** The CSS dimensions are shared by actual rows and their virtual offsets. */
export function useHostWindow(rows: HostRow[], cursorId: string | null, focusedId: string | null, enabled: boolean) {
  const region = useRef<HTMLDivElement>(null);
  const previousCursor = useRef(cursorId);
  const [viewport, setViewport] = useState({top: 0, height: 580});
  const [sizes, setSizes] = useState({host: 58, group: 36, head: 36});
  const layout = useMemo(() => {
    const offsets = [0], indices = new Map<string, number>(), aria: number[] = [];
    let rowCount = 1;
    rows.forEach((row, index) => {
      indices.set(row.host.id, index);
      if (row.groupStart) rowCount++;
      aria.push(++rowCount);
      offsets.push(offsets[index] + sizes.host + (row.groupStart ? sizes.group : 0));
    });
    return {offsets, indices, aria, rowCount, height: offsets.at(-1) || 0};
  }, [rows, sizes]);
  useLayoutEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () => {
      const css = getComputedStyle(element);
      const host = parseFloat(css.getPropertyValue('--host-row-height')) || 58;
      const group = parseFloat(css.getPropertyValue('--host-group-height')) || 36;
      const head = parseFloat(css.getPropertyValue('--host-head-height')) || 36;
      setSizes(previous => previous.host === host && previous.group === group && previous.head === head ? previous : {host, group, head});
      setViewport({top: element.scrollTop, height: element.clientHeight || 580});
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener('resize', measure);
    return () => {observer?.disconnect(); window.removeEventListener('resize', measure);};
  }, [enabled, !!rows.length]);
  useLayoutEffect(() => {
    const moved = previousCursor.current !== cursorId;
    previousCursor.current = cursorId;
    // Filtering, regrouping and metadata refreshes preserve cursor identity
    // without hijacking the user's scroll position. Only navigation scrolls.
    if (!moved) return;
    const element = region.current, index = cursorId ? layout.indices.get(cursorId) : undefined;
    if (!element || index === undefined) return;
    const start = layout.offsets[index], end = layout.offsets[index + 1];
    const height = element.clientHeight || viewport.height;
    let top = element.scrollTop;
    if (start < top) top = start;
    else if (end > top + height - sizes.head) top = end - height + sizes.head;
    if (top !== element.scrollTop) {element.scrollTop = top; setViewport({top, height});}
  }, [cursorId, layout, sizes.head]);
  const top = Math.min(viewport.top, Math.max(0, layout.height + sizes.head - viewport.height));
  useLayoutEffect(() => {
    if (region.current && top !== viewport.top) {region.current.scrollTop = top; setViewport(previous => ({...previous, top}));}
  }, [top, viewport.top]);
  const start = enabled ? Math.max(0, lowerBound(layout.offsets, top) - 1 - overscan) : 0;
  const end = enabled ? Math.min(rows.length, lowerBound(layout.offsets, top + viewport.height) + overscan) : rows.length;
  const visible = new Set<number>();
  for (let index = start; index < end; index++) visible.add(index);
  // Keep the actual focused control/menu mounted when the user scrolls away.
  const focused = focusedId ? layout.indices.get(focusedId) : undefined;
  if (enabled && focused !== undefined) visible.add(focused);
  return {region, height: layout.height, rowCount: layout.rowCount,
    onScroll: () => {const element = region.current; if (element) setViewport({top: element.scrollTop, height: element.clientHeight || 580});},
    visible: [...visible].sort((a, b) => a - b).map(index => ({...rows[index], index, offset: layout.offsets[index], ariaIndex: layout.aria[index]}))};
}
