from github_to_eat.preflight import PreflightResult, preflight


class FakeClient:
    def __init__(self, project=None, has_stories=False):
        self._project = {"title": "Demo"} if project is None else project
        self._has_stories = has_stories
        self.calls: list = []

    def get_meta(self):
        self.calls.append("meta")
        return {}

    def get_project(self, project_id):
        self.calls.append(("project", project_id))
        return self._project

    def project_has_stories(self, project_id):
        self.calls.append(("stories", project_id))
        return self._has_stories


def test_preflight_happy_path():
    client = FakeClient(project={"title": "My Board"}, has_stories=False)
    result = preflight(client, 91)
    assert result == PreflightResult(project_id=91, project_title="My Board", non_empty=False)


def test_preflight_checks_connectivity_first():
    client = FakeClient()
    preflight(client, 91)
    assert client.calls[0] == "meta"


def test_preflight_reports_non_empty():
    assert preflight(FakeClient(has_stories=True), 91).non_empty is True


def test_preflight_title_falls_back_to_name():
    assert preflight(FakeClient(project={"name": "Named"}), 91).project_title == "Named"


def test_preflight_title_default_when_missing():
    assert preflight(FakeClient(project={}), 7).project_title == "project 7"


def test_preflight_prefers_project_title():
    client = FakeClient(project={"project_title": "Real Name", "title": "legacy"})
    assert preflight(client, 91).project_title == "Real Name"
