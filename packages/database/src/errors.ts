export class StaleAttemptError extends Error {
  constructor(message = "Step attempt commit failed because attempt is no longer active (fenced out).") {
    super(message);
    this.name = "StaleAttemptError";
  }
}
