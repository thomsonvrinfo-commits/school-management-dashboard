/**
 * A business-rule failure, described in a form a form-field or an API error can both use.
 * `code` is stable and machine-readable; `message` is written for the person who has to fix it.
 */
export interface Problem {
  code: string;
  message: string;
  /** The input field the problem is about, when there is one (for example "admissionNo"). */
  field?: string;
}

export const problem = (code: string, message: string, field?: string): Problem =>
  field === undefined ? { code, message } : { code, message, field };
