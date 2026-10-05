/// Nivel de acceso de un participante a una sesión.
///
/// Es un único nivel ordenado (`None < View < Write`) en lugar de flags
/// independientes, así que no existe forma de representar "Escribir sin Ver":
/// `Write` implica `View` por construcción.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AccessLevel {
    /// Sin acceso: la sesión no está compartida con esta persona.
    None,
    /// Ver: permiso mínimo para que la sesión esté compartida. Es el valor por defecto.
    View,
    /// Escribir en las terminales de la sesión (incluye Ver).
    Write,
}

impl AccessLevel {
    /// Nivel con el que arranca un participante: Ver activo.
    pub const DEFAULT: AccessLevel = AccessLevel::View;

    pub fn can_view(self) -> bool {
        self >= AccessLevel::View
    }

    pub fn can_write(self) -> bool {
        self >= AccessLevel::Write
    }

    /// Activa o desactiva Ver. Desactivarlo revoca también Escribir (queda sin acceso).
    pub fn with_view(self, enabled: bool) -> AccessLevel {
        if enabled {
            self.max(AccessLevel::View)
        } else {
            AccessLevel::None
        }
    }

    /// Activa o desactiva Escribir. Activarlo activa también Ver;
    /// desactivarlo conserva Ver.
    pub fn with_write(self, enabled: bool) -> AccessLevel {
        if enabled {
            AccessLevel::Write
        } else {
            self.min(AccessLevel::View)
        }
    }
}

impl Default for AccessLevel {
    fn default() -> Self {
        AccessLevel::DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::AccessLevel::{self, *};

    #[test]
    fn default_is_view() {
        assert_eq!(AccessLevel::default(), View);
        assert!(AccessLevel::default().can_view());
        assert!(!AccessLevel::default().can_write());
    }

    #[test]
    fn write_without_view_is_unrepresentable() {
        for level in [None, View, Write] {
            if level.can_write() {
                assert!(level.can_view(), "{level:?} permite escribir sin ver");
            }
        }
    }

    #[test]
    fn enabling_write_enables_view() {
        assert_eq!(None.with_write(true), Write);
        assert!(None.with_write(true).can_view());
    }

    #[test]
    fn disabling_view_revokes_write_and_access() {
        let level = Write.with_view(false);
        assert_eq!(level, None);
        assert!(!level.can_view());
        assert!(!level.can_write());
    }

    #[test]
    fn disabling_write_keeps_view() {
        assert_eq!(Write.with_write(false), View);
        assert_eq!(None.with_write(false), None);
    }

    #[test]
    fn enabling_view_does_not_downgrade_write() {
        assert_eq!(Write.with_view(true), Write);
        assert_eq!(None.with_view(true), View);
    }
}
