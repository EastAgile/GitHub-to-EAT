import pytest
import responses

from github_to_eat.client import AuthError, EATClient, EATError, NotFoundError

BASE = "https://api.test/api/v1"


def make_client() -> EATClient:
    return EATClient(BASE, "tok")


@responses.activate
def test_get_meta_ok_sends_token():
    responses.get(f"{BASE}/meta", json={"ok": True}, status=200)
    assert make_client().get_meta() == {"ok": True}
    assert responses.calls[0].request.headers["X-TrackerToken"] == "tok"


@responses.activate
def test_auth_error_on_401():
    responses.get(f"{BASE}/meta", status=401)
    with pytest.raises(AuthError):
        make_client().get_meta()


@responses.activate
def test_auth_error_on_403():
    responses.get(f"{BASE}/projects/91", status=403)
    with pytest.raises(AuthError):
        make_client().get_project(91)


@responses.activate
def test_get_project_ok():
    responses.get(f"{BASE}/projects/91", json={"id": 91, "title": "Demo"}, status=200)
    assert make_client().get_project(91)["title"] == "Demo"


@responses.activate
def test_not_found_on_404():
    responses.get(f"{BASE}/projects/999", status=404)
    with pytest.raises(NotFoundError):
        make_client().get_project(999)


@responses.activate
def test_server_error_raises_eaterror():
    responses.get(f"{BASE}/meta", status=500, body="boom")
    with pytest.raises(EATError):
        make_client().get_meta()


@responses.activate
def test_project_has_stories_true_bare_list():
    responses.get(f"{BASE}/projects/91/stories", json=[{"id": 1}], status=200)
    assert make_client().project_has_stories(91) is True


@responses.activate
def test_project_has_stories_false_on_empty():
    responses.get(f"{BASE}/projects/91/stories", json=[], status=200)
    assert make_client().project_has_stories(91) is False


@responses.activate
def test_project_has_stories_true_wrapped():
    responses.get(f"{BASE}/projects/91/stories", json={"stories": [{"id": 1}]}, status=200)
    assert make_client().project_has_stories(91) is True
