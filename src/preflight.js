/** Preflight checks: read-only validation that runs before any import writes. */

/**
 * The subset of the client the preflight needs (kept structural for tests).
 *
 * @typedef {object} PreflightClient
 * @property {() => Promise<any>} getMeta
 * @property {(projectId: number) => Promise<any>} getProject
 * @property {(projectId: number) => Promise<boolean>} projectHasStories
 */

/**
 * @typedef {object} PreflightResult
 * @property {number} projectId
 * @property {string} projectTitle
 * @property {boolean} nonEmpty
 */

/**
 * @param {any} project
 * @param {number} projectId
 * @returns {string}
 */
function projectTitle(project, projectId) {
  // EAT returns the project name in `project_title`; keep title/name as fallbacks.
  for (const key of ["project_title", "title", "name"]) {
    const value = project[key];
    if (value) return String(value);
  }
  return `project ${projectId}`;
}

/**
 * Confirm the API/token work and the project is reachable; flag if non-empty.
 *
 * Runs the connectivity check first so an invalid token fails fast before we
 * touch the project.
 *
 * @param {PreflightClient} client
 * @param {number} projectId
 * @returns {Promise<PreflightResult>}
 */
export async function preflight(client, projectId) {
  await client.getMeta();
  const project = await client.getProject(projectId);
  return {
    projectId,
    projectTitle: projectTitle(project, projectId),
    nonEmpty: await client.projectHasStories(projectId),
  };
}
