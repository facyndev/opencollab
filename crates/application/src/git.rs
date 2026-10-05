//! Rama de git de una carpeta. La lectura del disco es del adaptador; acá vive
//! solo la interpretación de `HEAD`, que es pura.

/// Dónde está parada una carpeta dentro de un repositorio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Branch {
    /// `HEAD` apunta a una rama.
    Named(String),
    /// `HEAD` apunta directo a un commit; guarda su SHA corto.
    Detached(String),
}

impl Branch {
    /// Lo que se muestra: el nombre de la rama o el SHA corto.
    pub fn label(&self) -> &str {
        match self {
            Branch::Named(name) | Branch::Detached(name) => name,
        }
    }

    pub fn is_detached(&self) -> bool {
        matches!(self, Branch::Detached(_))
    }
}

const SHORT_SHA_LEN: usize = 7;

/// Interpreta el contenido de un archivo `HEAD`: `ref: refs/heads/<rama>` o un
/// SHA crudo (HEAD desacoplado). Cualquier otra cosa no es una rama.
pub fn parse_head(content: &str) -> Option<Branch> {
    let content = content.trim();
    if let Some(reference) = content.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return (!name.is_empty()).then(|| Branch::Named(name.to_string()));
    }
    let is_sha = content.len() >= 40 && content.bytes().all(|b| b.is_ascii_hexdigit());
    is_sha.then(|| Branch::Detached(content[..SHORT_SHA_LEN].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "3f786850e387550fdab836ed7e6dc881de23001b";

    #[test]
    fn a_symbolic_head_is_a_named_branch() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some(Branch::Named("main".into()))
        );
    }

    #[test]
    fn branch_names_keep_their_slashes() {
        assert_eq!(
            parse_head("ref: refs/heads/feature/agent-status-info"),
            Some(Branch::Named("feature/agent-status-info".into()))
        );
    }

    #[test]
    fn a_raw_sha_is_a_detached_head_with_a_short_sha() {
        assert_eq!(
            parse_head(&format!("{SHA}\n")),
            Some(Branch::Detached("3f78685".into()))
        );
    }

    #[test]
    fn garbage_is_not_a_branch() {
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("hello"), None);
        assert_eq!(parse_head("3f78"), None);
        assert_eq!(parse_head("ref: "), None);
    }

    #[test]
    fn the_label_is_the_name_or_the_short_sha() {
        assert_eq!(Branch::Named("main".into()).label(), "main");
        assert_eq!(Branch::Detached("3f78685".into()).label(), "3f78685");
    }
}
