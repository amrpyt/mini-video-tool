use std::io;

#[cfg(any(windows, test))]
fn taskkill_command(pid: u32) -> std::process::Command {
    let mut command = std::process::Command::new("taskkill");
    command.arg("/PID").arg(pid.to_string()).arg("/T").arg("/F");
    command
}

#[cfg(windows)]
pub fn terminate_process_tree(pid: u32) -> io::Result<()> {
    let status = taskkill_command(pid).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "taskkill failed for process {pid} with status {status}"
        )))
    }
}

#[cfg(not(windows))]
pub fn terminate_process_tree(_pid: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree termination is only supported on Windows",
    ))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::taskkill_command;

    #[test]
    fn taskkill_uses_direct_program_and_arguments() {
        let command = taskkill_command(4242);

        assert_eq!(command.get_program(), OsStr::new("taskkill"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("/PID"),
                OsStr::new("4242"),
                OsStr::new("/T"),
                OsStr::new("/F"),
            ]
        );
    }
}
