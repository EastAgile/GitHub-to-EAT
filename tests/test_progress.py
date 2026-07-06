import io

import pytest

from github_to_eat.progress import run_with_progress


def test_returns_func_result():
    out = io.StringIO()
    assert run_with_progress(lambda: 42, "working", stream=out) == 42
    assert "working" in out.getvalue()


def test_propagates_exception():
    out = io.StringIO()

    class Boom(Exception):
        pass

    def boom():
        raise Boom("nope")

    with pytest.raises(Boom):
        run_with_progress(boom, "working", stream=out)
