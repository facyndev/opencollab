import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export type MenuAlign = "left" | "right";
export type MenuPosition = { left?: number; right?: number; top: number };

export function anchorMenuPosition(
  rect: Pick<DOMRectReadOnly, "left" | "right" | "bottom">,
  align: MenuAlign = "left",
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0,
  gap = 4,
): MenuPosition {
  if (align === "right") {
    return {
      right: viewportWidth - rect.right,
      top: rect.bottom + gap,
    };
  }
  return {
    left: rect.left,
    top: rect.bottom + gap,
  };
}

export function clampMenuPosition(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 210,
  menuHeight = 160,
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.min(clientX, Math.max(margin, viewportWidth - menuWidth - margin)),
    top: Math.min(clientY, Math.max(margin, viewportHeight - menuHeight - margin)),
  };
}

type Props = {
  open: boolean;
  onClose: () => void;
  /// Botón que abre el menú: el menú se ubica debajo suyo y los clics sobre él no disparan `onClose` acá.
  anchorRef?: RefObject<HTMLElement | null>;
  /// Alineación respecto de `anchorRef` (`left` en CwdSwitcher, `right` en NewTerminalMenu).
  align?: MenuAlign;
  /// Coordenadas fijas cuando el menú se abre en el cursor (p. ej. clic derecho en la terminal).
  position?: MenuPosition | null;
  className?: string;
  children: ReactNode;
};

/// Menú flotante renderizado en un portal sobre `document.body` para no quedar
/// recortado por contenedores con `overflow: hidden`. Se cierra solo con clic
/// afuera (`pointerdown`), `Escape` o al redimensionar la ventana.
export function PopoverMenu({
  open,
  onClose,
  anchorRef,
  align = "left",
  position,
  className,
  children,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [anchorPos, setAnchorPos] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || position || !anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setAnchorPos(anchorMenuPosition(rect, align, window.innerWidth));
  }, [open, position, anchorRef, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, anchorRef]);

  const resolvedPosition = position ?? anchorPos;
  if (!open || !resolvedPosition) return null;

  const classes = ["cwd-menu", className].filter(Boolean).join(" ");

  return createPortal(
    <div className={classes} role="menu" ref={menuRef} style={resolvedPosition}>
      {children}
    </div>,
    document.body,
  );
}
