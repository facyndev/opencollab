use std::path::{Path, PathBuf};

use application::ports::RepositoryInspector;
use application::{git::parse_head, Branch};

/// [`RepositoryInspector`] que lee `.git/HEAD` directo del disco: no necesita el
/// binario `git`. Cubre repositorios normales y los de `.git` como archivo
/// (`gitdir: <ruta>`: worktrees y submódulos).
#[derive(Default)]
pub struct FsRepositoryInspector;

impl FsRepositoryInspector {
    pub fn new() -> Self {
        Self
    }
}

impl RepositoryInspector for FsRepositoryInspector {
    fn current_branch(&self, path: &Path) -> Option<Branch> {
        let start = if path.is_file() { path.parent()? } else { path };
        // El primer `.git` que aparece hacia arriba es el del repositorio: si no
        // se puede leer, no se sigue buscando en carpetas más arriba.
        let git = start
            .ancestors()
            .map(|dir| dir.join(".git"))
            .find(|git| git.exists())?;
        let head = git_dir(&git)?.join("HEAD");
        parse_head(&std::fs::read_to_string(head).ok()?)
    }
}

/// Carpeta con el `HEAD`: el propio `.git`, o la que apunta un archivo `.git`.
fn git_dir(git: &Path) -> Option<PathBuf> {
    if git.is_dir() {
        return Some(git.to_path_buf());
    }
    let content = std::fs::read_to_string(git).ok()?;
    let target = content.trim().strip_prefix("gitdir:")?.trim();
    // Una ruta relativa se resuelve desde la carpeta que contiene el archivo.
    Some(git.parent()?.join(target))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use application::ports::RepositoryInspector;
    use application::Branch;

    use super::*;

    const SHA: &str = "3f786850e387550fdab836ed7e6dc881de23001b";

    /// Carpeta temporal propia de cada test, borrada al soltarse.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("oc-git-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn branch(path: &Path) -> Option<Branch> {
        FsRepositoryInspector::new().current_branch(path)
    }

    #[test]
    fn reads_the_branch_of_a_normal_repository() {
        let dir = TempDir::new("normal");
        write(&dir.path().join(".git/HEAD"), "ref: refs/heads/main\n");
        assert_eq!(branch(dir.path()), Some(Branch::Named("main".into())));
    }

    #[test]
    fn walks_up_from_a_subfolder() {
        let dir = TempDir::new("subfolder");
        write(&dir.path().join(".git/HEAD"), "ref: refs/heads/dev\n");
        let deep = dir.path().join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(branch(&deep), Some(Branch::Named("dev".into())));
    }

    #[test]
    fn follows_a_gitdir_file_with_an_absolute_path() {
        // Worktree: `.git` es un archivo que apunta a `<repo>/.git/worktrees/<n>`.
        let dir = TempDir::new("worktree");
        let gitdir = dir.path().join("main/.git/worktrees/wt");
        write(&gitdir.join("HEAD"), "ref: refs/heads/feature/x\n");
        let worktree = dir.path().join("wt");
        write(
            &worktree.join(".git"),
            &format!("gitdir: {}\n", gitdir.display()),
        );
        assert_eq!(branch(&worktree), Some(Branch::Named("feature/x".into())));
    }

    #[test]
    fn follows_a_gitdir_file_with_a_relative_path() {
        // Submódulo: la ruta es relativa a la carpeta que contiene el archivo.
        let dir = TempDir::new("submodule");
        write(
            &dir.path().join("super/.git/modules/sub/HEAD"),
            "ref: refs/heads/sub-branch\n",
        );
        let sub = dir.path().join("super/sub");
        write(&sub.join(".git"), "gitdir: ../.git/modules/sub\n");
        assert_eq!(branch(&sub), Some(Branch::Named("sub-branch".into())));
    }

    #[test]
    fn a_detached_head_reports_the_short_sha() {
        let dir = TempDir::new("detached");
        write(&dir.path().join(".git/HEAD"), &format!("{SHA}\n"));
        assert_eq!(branch(dir.path()), Some(Branch::Detached("3f78685".into())));
    }

    #[test]
    fn outside_a_repository_there_is_no_branch() {
        // La carpeta temporal del sistema no está dentro de ningún repositorio.
        let dir = TempDir::new("outside");
        assert_eq!(branch(dir.path()), None);
    }

    #[test]
    fn an_unreadable_head_is_no_branch() {
        let dir = TempDir::new("broken");
        write(&dir.path().join(".git/HEAD"), "???");
        assert_eq!(branch(dir.path()), None);
        let dir = TempDir::new("nohead");
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        assert_eq!(branch(dir.path()), None);
        let dir = TempDir::new("brokenfile");
        write(&dir.path().join(".git"), "not a gitdir pointer");
        assert_eq!(branch(dir.path()), None);
    }

    #[test]
    fn a_path_that_is_a_file_uses_its_folder() {
        let dir = TempDir::new("file");
        write(&dir.path().join(".git/HEAD"), "ref: refs/heads/main\n");
        write(&dir.path().join("README.md"), "x");
        assert_eq!(
            branch(&dir.path().join("README.md")),
            Some(Branch::Named("main".into()))
        );
    }
}
