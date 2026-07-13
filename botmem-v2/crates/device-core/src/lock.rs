use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

/// An advisory lock held for the lifetime of the device engine.
///
/// `flock` semantics cover separate processes and repeated opens within one
/// process. The signed app must acquire this before opening its store.
#[derive(Debug)]
pub struct EngineLock {
    file: File,
    path: PathBuf,
}

impl EngineLock {
    pub fn try_acquire(root: impl AsRef<Path>) -> Result<Self, LockError> {
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        set_dir_private(root)?;

        let path = root.join("engine.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options.mode(0o600);

        let file = options.open(&path)?;
        set_file_private(&path)?;
        FileExt::try_lock_exclusive(&file).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                LockError::AlreadyRunning { path: path.clone() }
            } else {
                LockError::Io(error)
            }
        })?;

        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for EngineLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn set_dir_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn set_file_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum LockError {
    #[error("another Botmem device engine holds {path}", path = .path.display())]
    AlreadyRunning { path: PathBuf },
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_engine_cannot_acquire_the_lock() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first = EngineLock::try_acquire(directory.path()).expect("first lock");
        let second = EngineLock::try_acquire(directory.path());
        assert!(matches!(second, Err(LockError::AlreadyRunning { .. })));
        drop(first);
        EngineLock::try_acquire(directory.path()).expect("lock after release");
    }
}
