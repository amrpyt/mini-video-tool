use std::{
    io,
    sync::{Arc, Mutex, mpsc},
    thread,
};

use mini_video_tool_v2::{
    error::AppError,
    jobs::{JobKind, JobManager, JobOutcome, JobStatus},
};

#[test]
fn rejects_a_second_heavy_job_while_one_is_running() {
    let manager = JobManager::with_terminator(|_| Ok(()));
    let first = manager.begin(JobKind::Download).expect("start first job");

    assert_eq!(
        manager.status(first).expect("first status"),
        JobStatus::Running
    );
    assert!(manager.begin(JobKind::Export).is_err());
}

#[test]
fn cancel_moves_running_through_cancelling_to_cancelled() {
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let manager = Arc::new(JobManager::with_terminator(move |pid| {
        entered_tx.send(pid).expect("report process termination");
        release_rx
            .lock()
            .expect("lock release receiver")
            .recv()
            .expect("release process termination");
        Ok(())
    }));
    let job = manager.begin(JobKind::Download).expect("start job");
    manager.attach_process(job, 101).expect("attach process");

    let cancelling_manager = Arc::clone(&manager);
    let cancel = thread::spawn(move || cancelling_manager.cancel_active());

    assert_eq!(entered_rx.recv().expect("termination started"), 101);
    assert_eq!(
        manager.status(job).expect("cancelling status"),
        JobStatus::Cancelling
    );

    release_tx.send(()).expect("release process termination");
    cancel
        .join()
        .expect("cancel thread")
        .expect("cancel active job");
    assert_eq!(
        manager.status(job).expect("cancelled status"),
        JobStatus::Cancelled
    );
}

#[test]
fn repeated_cancel_does_not_release_the_heavy_job_slot_while_termination_is_running() {
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let manager = Arc::new(JobManager::with_terminator(move |pid| {
        entered_tx.send(pid).expect("report process termination");
        release_rx
            .lock()
            .expect("lock release receiver")
            .recv()
            .expect("release process termination");
        Ok(())
    }));
    let job = manager.begin(JobKind::Download).expect("start job");
    manager.attach_process(job, 151).expect("attach process");

    let cancelling_manager = Arc::clone(&manager);
    let cancel = thread::spawn(move || cancelling_manager.cancel_active());
    assert_eq!(entered_rx.recv().expect("termination started"), 151);

    manager
        .cancel_active()
        .expect("repeat cancellation request");
    assert_eq!(
        manager.status(job).expect("job status"),
        JobStatus::Cancelling
    );
    assert!(manager.begin(JobKind::Export).is_err());

    release_tx.send(()).expect("release process termination");
    cancel
        .join()
        .expect("cancel thread")
        .expect("cancel active job");
    assert_eq!(
        manager.status(job).expect("final status"),
        JobStatus::Cancelled
    );
}

#[test]
fn failed_termination_after_finish_during_cancelling_keeps_pid_owned_and_retryable() {
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let attempts_for_terminator = Arc::clone(&attempts);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let manager = Arc::new(JobManager::with_terminator(move |pid| {
        let attempt = {
            let mut attempts = attempts_for_terminator.lock().expect("lock attempts");
            attempts.push(pid);
            attempts.len()
        };

        if attempt == 1 {
            entered_tx.send(pid).expect("report first termination");
            release_rx
                .lock()
                .expect("lock release receiver")
                .recv()
                .expect("release first termination");
            return Err(io::Error::other("simulated taskkill failure"));
        }

        Ok(())
    }));
    let job = manager.begin(JobKind::Download).expect("start job");
    manager.attach_process(job, 171).expect("attach process");

    let cancelling_manager = Arc::clone(&manager);
    let cancel = thread::spawn(move || cancelling_manager.cancel_active());
    assert_eq!(entered_rx.recv().expect("termination started"), 171);
    assert_eq!(
        manager.status(job).expect("cancelling status"),
        JobStatus::Cancelling
    );

    manager
        .finish(job, JobOutcome::Completed)
        .expect("stale finish during cancellation");
    assert_eq!(
        manager.status(job).expect("status after stale finish"),
        JobStatus::Cancelling
    );
    assert!(manager.begin(JobKind::Export).is_err());

    release_tx.send(()).expect("release failed termination");
    assert!(cancel.join().expect("cancel thread").is_err());

    assert_eq!(
        manager
            .status(job)
            .expect("status after failed termination"),
        JobStatus::Cancelling
    );
    assert!(manager.begin(JobKind::Export).is_err());

    manager.cancel_active().expect("retry cancellation");
    assert_eq!(*attempts.lock().expect("lock attempts"), vec![171, 171]);
    assert_eq!(
        manager.status(job).expect("final cancelled status"),
        JobStatus::Cancelled
    );

    manager
        .finish(job, JobOutcome::Completed)
        .expect("stale completion stays cancelled");
    assert_eq!(
        manager.status(job).expect("status after stale completion"),
        JobStatus::Cancelled
    );
    assert!(manager.begin(JobKind::Export).is_ok());
}

#[test]
fn observed_process_exit_during_failed_cancellation_releases_slot_without_restoring_dead_pid() {
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let attempts_for_terminator = Arc::clone(&attempts);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let manager = Arc::new(JobManager::with_terminator(move |pid| {
        attempts_for_terminator
            .lock()
            .expect("lock attempts")
            .push(pid);
        entered_tx.send(pid).expect("report termination attempt");
        release_rx
            .lock()
            .expect("lock release receiver")
            .recv()
            .expect("release termination attempt");
        Err(io::Error::other("process already exited"))
    }));
    let job = manager.begin(JobKind::Download).expect("start job");
    manager.attach_process(job, 181).expect("attach process");

    let cancelling_manager = Arc::clone(&manager);
    let cancel = thread::spawn(move || cancelling_manager.cancel_active());
    assert_eq!(entered_rx.recv().expect("termination started"), 181);
    assert_eq!(
        manager.status(job).expect("cancelling status"),
        JobStatus::Cancelling
    );

    manager
        .process_exited(job)
        .expect("record authoritative child exit");
    manager
        .finish(job, JobOutcome::Completed)
        .expect("stale completion cannot win");
    assert_eq!(
        manager.status(job).expect("status after observed exit"),
        JobStatus::Cancelled
    );

    release_tx.send(()).expect("release failed taskkill");
    cancel
        .join()
        .expect("cancel thread")
        .expect("observed exit resolves cancellation");
    assert_eq!(*attempts.lock().expect("lock attempts"), vec![181]);
    assert!(manager.begin(JobKind::Export).is_ok());
}

#[test]
fn stale_completion_after_cancellation_never_becomes_completed() {
    let manager = JobManager::with_terminator(|_| Ok(()));
    let cancelled = manager.begin(JobKind::SilenceAnalysis).expect("start job");

    manager.cancel_active().expect("cancel job");
    assert_eq!(
        manager.status(cancelled).expect("cancelled status"),
        JobStatus::Cancelled
    );

    let replacement = manager.begin(JobKind::Export).expect("start replacement");
    manager
        .finish(cancelled, JobOutcome::Completed)
        .expect("ignore stale completion");

    assert_eq!(
        manager.status(cancelled).expect("old status"),
        JobStatus::Cancelled
    );
    assert_eq!(
        manager.status(replacement).expect("replacement status"),
        JobStatus::Running
    );
}

#[test]
fn process_attached_after_cancel_request_is_terminated_immediately() {
    let kills = Arc::new(Mutex::new(Vec::new()));
    let kills_for_terminator = Arc::clone(&kills);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let manager = Arc::new(JobManager::with_terminator(move |pid| {
        kills_for_terminator
            .lock()
            .expect("lock kill log")
            .push(pid);
        if pid == 111 {
            entered_tx.send(pid).expect("report first termination");
            release_rx
                .lock()
                .expect("lock release receiver")
                .recv()
                .expect("release first termination");
        }
        Ok(())
    }));
    let job = manager.begin(JobKind::Download).expect("start job");
    manager
        .attach_process(job, 111)
        .expect("attach first process");

    let cancelling_manager = Arc::clone(&manager);
    let cancel = thread::spawn(move || cancelling_manager.cancel_active());
    assert_eq!(entered_rx.recv().expect("cancel reached terminator"), 111);
    assert_eq!(
        manager.status(job).expect("cancelling status"),
        JobStatus::Cancelling
    );

    let late_attach = manager.attach_process(job, 222);
    assert!(matches!(late_attach, Err(AppError::Cancelled)));
    assert!(kills.lock().expect("lock kill log").contains(&222));

    release_tx.send(()).expect("release cancellation");
    cancel
        .join()
        .expect("cancel thread")
        .expect("cancel active job");
    manager
        .finish(job, JobOutcome::Completed)
        .expect("ignore stale successful finish");
    assert_eq!(
        manager.status(job).expect("final status"),
        JobStatus::Cancelled
    );
}

#[test]
fn cancelling_only_terminates_the_active_job_process() {
    let kills = Arc::new(Mutex::new(Vec::new()));
    let kills_for_terminator = Arc::clone(&kills);
    let manager = JobManager::with_terminator(move |pid| {
        kills_for_terminator
            .lock()
            .expect("lock kill log")
            .push(pid);
        Ok::<(), io::Error>(())
    });

    let first = manager.begin(JobKind::Download).expect("start first job");
    manager
        .attach_process(first, 301)
        .expect("attach first process");
    manager
        .finish(first, JobOutcome::Completed)
        .expect("finish first job");

    let active = manager.begin(JobKind::Export).expect("start active job");
    manager
        .attach_process(active, 302)
        .expect("attach active process");
    manager.cancel_active().expect("cancel active job");

    assert_eq!(*kills.lock().expect("lock kill log"), vec![302]);
    assert_eq!(
        manager.status(first).expect("first status"),
        JobStatus::Completed
    );
    assert_eq!(
        manager.status(active).expect("active status"),
        JobStatus::Cancelled
    );
}
