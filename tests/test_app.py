import unittest
import threading
from unittest.mock import Mock, patch

from app import MiniVideoTool, terminate_process_tree


class CancellationTests(unittest.TestCase):
    def test_windows_cancel_terminates_the_whole_child_process_tree(self):
        process = Mock(pid=4321)
        process.poll.return_value = None
        with patch("app.sys.platform", "win32"), patch("app.subprocess.run") as run:
            run.return_value.returncode = 0
            terminate_process_tree(process)
        command = run.call_args.args[0]
        self.assertEqual(command, ["taskkill", "/PID", "4321", "/T", "/F"])

    def test_windows_cancel_falls_back_to_direct_kill_if_taskkill_fails(self):
        process = Mock(pid=4321)
        process.poll.return_value = None
        with patch("app.sys.platform", "win32"), patch("app.subprocess.run") as run:
            run.return_value.returncode = 1
            terminate_process_tree(process)
        process.kill.assert_called_once_with()

    def test_cancel_button_marks_job_cancelled_and_kills_active_process(self):
        tool = object.__new__(MiniVideoTool)
        tool.busy = True
        tool.cancel_event = threading.Event()
        tool._process_lock = threading.Lock()
        tool._active_process = Mock()
        tool.cancel_button = Mock()
        tool.activity_detail_var = Mock()
        with patch("app.terminate_process_tree") as terminate:
            MiniVideoTool._cancel_job(tool)
        self.assertTrue(tool.cancel_event.is_set())
        terminate.assert_called_once_with(tool._active_process)
        tool.cancel_button.configure.assert_called_with(state="disabled")

    def test_process_starting_after_cancel_is_terminated_immediately(self):
        tool = object.__new__(MiniVideoTool)
        tool.cancel_event = threading.Event()
        tool.cancel_event.set()
        tool._process_lock = threading.Lock()
        tool._active_process = None
        process = Mock()
        with patch("app.terminate_process_tree") as terminate:
            MiniVideoTool._set_active_process(tool, process)
        terminate.assert_called_once_with(process)


if __name__ == "__main__":
    unittest.main()
