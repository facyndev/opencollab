use std::path::{Path, PathBuf};

/// Parsea una línea de formato `.env`. Devuelve `(clave, valor)` o `None` si es
/// comentario, está vacía o es inválida.
pub fn parse_env_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, val) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let val = val.trim();
    let val = if (val.starts_with('"') && val.ends_with('"'))
        || (val.starts_with('\'') && val.ends_with('\''))
    {
        if val.len() >= 2 {
            &val[1..val.len() - 1]
        } else {
            val
        }
    } else {
        val
    };
    Some((key, val))
}

/// Busca el archivo `.env` en `dir` y sus directorios padre.
fn find_env_file_from(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

/// Carga las variables de un archivo `.env` en el entorno del proceso si no
/// están ya definidas en el sistema.
pub fn load_dot_env() {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    for start in candidates {
        if let Some(path) = find_env_file_from(&start) {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines() {
                    if let Some((key, val)) = parse_env_line(line) {
                        if std::env::var_os(key).is_none() {
                            std::env::set_var(key, val);
                        }
                    }
                }
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_key_value() {
        assert_eq!(parse_env_line("FOO=bar"), Some(("FOO", "bar")));
        assert_eq!(parse_env_line("  PORT = 8080  "), Some(("PORT", "8080")));
    }

    #[test]
    fn ignores_comments_and_empty_lines() {
        assert_eq!(parse_env_line(""), None);
        assert_eq!(parse_env_line("   "), None);
        assert_eq!(parse_env_line("# Comentario"), None);
        assert_eq!(parse_env_line("  # Comentario identado"), None);
    }

    #[test]
    fn strips_enclosing_quotes() {
        assert_eq!(parse_env_line("FOO=\"bar baz\""), Some(("FOO", "bar baz")));
        assert_eq!(parse_env_line("FOO='bar baz'"), Some(("FOO", "bar baz")));
        assert_eq!(parse_env_line("FOO=\"\""), Some(("FOO", "")));
    }

    #[test]
    fn preserves_inner_equals_signs() {
        assert_eq!(
            parse_env_line("URL=https://example.com/login?foo=1&bar=2"),
            Some(("URL", "https://example.com/login?foo=1&bar=2"))
        );
    }

    #[test]
    fn rejects_missing_key() {
        assert_eq!(parse_env_line("=valor"), None);
        assert_eq!(parse_env_line("   =valor"), None);
    }
}
