/** An expected, user-facing failure (bad input, missing project…). Its message is shown as is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
