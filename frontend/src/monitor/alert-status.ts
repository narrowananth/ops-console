import { AlertStatus } from '@ops-console/shared';

/** What each Alert status means and what comes next, shown on hover of its chip. */
export const STATUS_TIP: Record<AlertStatus, string> = {
  [AlertStatus.Open]: 'Open: a Scan raised it. Verify it to have the agent explain it from the code.',
  [AlertStatus.Verifying]: 'Verifying: the agent is following the log through the code and writing a Report.',
  [AlertStatus.Verified]:
    'Verified: the Report is ready. Read it, then confirm it as a bug or improvement, or dismiss it.',
  [AlertStatus.Fixing]: 'Fixing: the agent is changing the code on a fix branch and testing it.',
  [AlertStatus.PrOpen]: 'PR open: the Fix is pushed and waits for review. Merging the PR resolves the Alert.',
  [AlertStatus.Resolved]: 'Resolved: the PR was merged. A new failure after a healthy Scan reopens it as a Regression.',
  [AlertStatus.Dismissed]:
    'Dismissed: you set it aside. A new failure after a healthy Scan reopens it as a Regression.',
};

/** Resolved and dismissed Alerts: out of the Monitor unless the operator asks for them. */
export const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];
