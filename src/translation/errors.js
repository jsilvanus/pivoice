/** An error from a translation route, with a code the router and the deadline rules understand. */
export class RouteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
