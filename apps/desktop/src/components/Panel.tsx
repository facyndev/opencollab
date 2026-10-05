import type { HTMLAttributes, ReactNode, Ref } from "react";

type Props = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  /// Elemento raíz (para semántica: `section` en un panel de terminal, `div` en una lista).
  as?: "section" | "div";
  ref?: Ref<HTMLElement>;
  /// Barra de título: va sobre el fondo del wrapper.
  header: ReactNode;
  /// Contenido del bloque interno (oscuro y con radio). Sin `children` ni
  /// `bodyRef` no se dibuja el bloque.
  children?: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  bodyClassName?: string;
  /// Sin marco: solo el contenido, sin fondo ni borde (p. ej. una sesión inactiva).
  plain?: boolean;
};

/// Wrapper visual de la app: un marco con la barra de título arriba y el
/// contenido en un bloque interno oscuro con radio, envuelto por el padding
/// del marco. Lo usan el panel de una terminal y la sesión del sidebar.
export function Panel({
  as: Root = "section",
  ref,
  header,
  children,
  bodyRef,
  bodyClassName,
  plain = false,
  className,
  ...rest
}: Props) {
  const hasBody = children !== undefined || bodyRef !== undefined;
  const classes = ["panel", plain && "panel--plain", className].filter(Boolean).join(" ");
  return (
    <Root
      ref={ref as Ref<HTMLDivElement>}
      className={classes}
      {...(rest as HTMLAttributes<HTMLDivElement>)}
    >
      {header}
      {hasBody && (
        <div ref={bodyRef} className={["panel-body", bodyClassName].filter(Boolean).join(" ")}>
          {children}
        </div>
      )}
    </Root>
  );
}
