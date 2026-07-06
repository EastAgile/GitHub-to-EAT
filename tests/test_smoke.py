from github_to_eat import __version__


def test_version_is_a_nonempty_string():
    assert isinstance(__version__, str) and __version__
