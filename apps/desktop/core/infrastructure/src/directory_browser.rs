use std::path::Path;

use application::ports::{DirectoryBrowser, PortError};

/// [`DirectoryBrowser`] sobre `std::fs`.
#[derive(Default)]
pub struct FsDirectoryBrowser;

impl FsDirectoryBrowser {
    pub fn new() -> Self {
        Self
    }
}

impl DirectoryBrowser for FsDirectoryBrowser {
    fn subdirectories(&self, path: &Path) -> Result<Vec<String>, PortError> {
        let entries = std::fs::read_dir(path)
            .map_err(|e| PortError::new(format!("{}: {e}", path.display())))?;
        Ok(entries
            // Entradas ilegibles (sin permisos, borradas en el medio) se saltean.
            .filter_map(Result::ok)
            // `metadata` sigue symlinks/junctions: una junction a carpeta cuenta como carpeta.
            .filter(|entry| std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_directories() {
        let root = std::env::temp_dir().join(format!("oc-dirs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("alpha")).unwrap();
        std::fs::create_dir_all(root.join("beta")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();

        let mut names = FsDirectoryBrowser::new().subdirectories(&root).unwrap();
        names.sort();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(names, ["alpha", "beta"]);
    }

    #[test]
    fn missing_directory_is_an_error() {
        let missing = std::env::temp_dir().join("oc-does-not-exist-xyz");
        assert!(FsDirectoryBrowser::new().subdirectories(&missing).is_err());
    }
}
