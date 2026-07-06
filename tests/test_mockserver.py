import pytest
import requests

from github_to_eat.client import EATClient, NotFoundError
from github_to_eat.mockserver import MockState, run_mock_server


def test_meta_and_project_via_client():
    with run_mock_server() as (base, _state):
        client = EATClient(base, "ea_token")
        assert "story_types" in client.get_meta()
        assert client.get_project(91)["title"] == "Mock Project"


def test_missing_project_returns_404():
    with run_mock_server() as (base, _state):
        client = EATClient(base, "ea_token")
        with pytest.raises(NotFoundError):
            client.get_project(999)


def test_has_stories_reflects_state():
    with run_mock_server(MockState(stories={91: [{"id": 1}]})) as (base, _state):
        assert EATClient(base, "ea_token").project_has_stories(91) is True


def test_empty_project_has_no_stories():
    with run_mock_server() as (base, _state):
        assert EATClient(base, "ea_token").project_has_stories(91) is False


def test_missing_token_returns_401():
    with run_mock_server() as (base, _state):
        assert requests.get(f"{base}/meta").status_code == 401


def test_import_records_body_and_idempotency_key():
    state = MockState(import_result={"imported": 5, "skipped": 1, "errors": []})
    with run_mock_server(state) as (base, recorded):
        resp = requests.post(
            f"{base}/projects/91/import/json",
            json={"source": "github", "owner": "o", "repo": "r"},
            headers={"X-TrackerToken": "ea_token", "Idempotency-Key": "abc"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"imported": 5, "skipped": 1, "errors": []}
        assert recorded.imports[0]["idempotency_key"] == "abc"
        assert recorded.imports[0]["body"]["source"] == "github"


def test_import_to_missing_project_404():
    with run_mock_server() as (base, _state):
        resp = requests.post(
            f"{base}/projects/999/import/json",
            json={"source": "github", "owner": "o", "repo": "r"},
            headers={"X-TrackerToken": "ea_token"},
        )
        assert resp.status_code == 404
