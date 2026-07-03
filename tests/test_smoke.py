from github_to_eat import __version__
from github_to_eat.cli import main


def test_version_is_a_nonempty_string():
    assert isinstance(__version__, str) and __version__


def test_main_reports_version(capsys):
    exit_code = main(["--version"])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert __version__ in captured.out
