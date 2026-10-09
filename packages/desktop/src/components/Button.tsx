import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  /// `primary`: acción principal (violeta, p. ej. "New terminal").
  /// `secondary`: acción secundaria con borde (p. ej. "Invite").
  variant?: "primary" | "secondary";
  /// Ícono a la izquierda del texto.
  icon?: ReactNode;
  /// `submit` solo dentro de un formulario; por defecto no envía nada.
  type?: "button" | "submit";
};

/// Botón con texto de la app.
export function Button({
  variant = "secondary",
  icon,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn", `btn--${variant}`, className].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  icon: ReactNode;
  /// Obligatorio: es el tooltip y el nombre accesible (no hay texto visible).
  title: string;
};

/// Botón de solo ícono (minimizar, cerrar, agregar, ajustes…).
export function IconButton({ icon, title, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={["icon-btn", className].filter(Boolean).join(" ")}
      title={title}
      aria-label={title}
      {...rest}
    >
      {icon}
    </button>
  );
}
