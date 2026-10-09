import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Arrastrar paneles por su header e intercambiarlos en vivo con animación.
//
// El orden visual sale de la propiedad CSS `order` de cada panel: el DOM nunca
// se reordena, así las instancias de xterm no se mueven ni pierden su estado.
// Los demás paneles se animan con FLIP: se mide dónde estaban antes del
// intercambio y se los anima desde ahí hasta su lugar nuevo.

const SWAP_MS = 220;
const DROP_MS = 180;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/// Distancia mínima antes de empezar a arrastrar, para no confundir un clic.
const DRAG_THRESHOLD = 4;

type Rect = { left: number; top: number; right: number; bottom: number };

type DragState = {
  id: string;
  startX: number;
  startY: number;
  /// Posición del puntero dentro del panel al agarrarlo.
  grabX: number;
  grabY: number;
  lastX: number;
  lastY: number;
  active: boolean;
};

type Options = {
  /// Orden actual de los paneles visibles de la sesión.
  order: string[];
  enabled: boolean;
  onSwap: (a: string, b: string) => void;
};

export function usePaneDrag({ order, enabled, onSwap }: Options) {
  const elements = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  /// Posiciones visuales tomadas justo antes de un intercambio (para FLIP).
  const before = useRef<Map<string, DOMRect> | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const registerPane = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  /// Dónde está el panel en el layout, ignorando cualquier transform en curso.
  const layoutRect = (el: HTMLElement): Rect => {
    const parent = el.offsetParent as HTMLElement | null;
    const base = parent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const left = base.left + (parent?.clientLeft ?? 0) + el.offsetLeft - (parent?.scrollLeft ?? 0);
    const top = base.top + (parent?.clientTop ?? 0) + el.offsetTop - (parent?.scrollTop ?? 0);
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  };

  /// El panel arrastrado sigue al puntero, aunque su lugar en la grilla cambie.
  const followPointer = useCallback(() => {
    const d = drag.current;
    const el = d && elements.current.get(d.id);
    if (!d || !el || !d.active) return;
    const slot = layoutRect(el);
    const x = d.lastX - d.grabX - slot.left;
    const y = d.lastY - d.grabY - slot.top;
    el.style.transform = `translate(${x}px, ${y}px) scale(1.02)`;
  }, []);

  // FLIP: después de cada intercambio, animar a los demás desde donde estaban.
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (previous) {
      for (const [id, oldRect] of previous) {
        const el = elements.current.get(id);
        if (!el || id === drag.current?.id) continue;
        el.style.transition = "none";
        el.style.transform = "";
        const newRect = el.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (dx === 0 && dy === 0) continue;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth; // forzar el layout antes de animar
        el.style.transition = `transform ${SWAP_MS}ms ${EASE}`;
        el.style.transform = "";
      }
    }
    followPointer();
  }, [order, followPointer]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;

      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.active = true;
        const el = elements.current.get(d.id);
        if (el) el.style.transition = "none";
        setDraggingId(d.id);
      }
      followPointer();

      // ¿El puntero está sobre otro panel? Intercambiar con ese.
      const target = order.find((id) => {
        if (id === d.id) return false;
        const el = elements.current.get(id);
        if (!el) return false;
        const r = layoutRect(el);
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (target) {
        before.current = new Map(
          order.flatMap((id) => {
            const el = elements.current.get(id);
            return el ? [[id, el.getBoundingClientRect()] as const] : [];
          }),
        );
        onSwap(d.id, target);
      }
    },
    [order, onSwap, followPointer],
  );

  const endDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const el = elements.current.get(d.id);
    if (el && d.active) {
      // Soltar: el panel vuelve animado a su lugar en la grilla.
      el.style.transition = `transform ${DROP_MS}ms ${EASE}`;
      el.style.transform = "";
    }
    setDraggingId(null);
  }, []);

  // Escuchar en window: el puntero puede salir del header durante el arrastre.
  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [onPointerMove, endDrag]);

  const startDrag = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (!enabled || e.button !== 0) return;
      // Los botones del header (minimizar, cerrar...) no arrancan un arrastre.
      if ((e.target as HTMLElement).closest("button")) return;
      const el = elements.current.get(id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      drag.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        grabX: e.clientX - r.left,
        grabY: e.clientY - r.top,
        lastX: e.clientX,
        lastY: e.clientY,
        active: false,
      };
      e.preventDefault(); // evita seleccionar texto
    },
    [enabled],
  );

  return { registerPane, startDrag, draggingId };
}
