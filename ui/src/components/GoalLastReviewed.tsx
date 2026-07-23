import { formatDate } from "../lib/utils";
import { Button } from "@/components/ui/button";

interface GoalLastReviewedControlProps {
  lastReviewedAt?: Date | string | null;
  onMarkReviewed?: () => void;
}

export function GoalLastReviewedControl({
  lastReviewedAt,
  onMarkReviewed,
}: GoalLastReviewedControlProps) {
  return (
    <>
      {lastReviewedAt ? (
        <span className="text-sm">{formatDate(lastReviewedAt)}</span>
      ) : (
        <span className="text-sm text-muted-foreground">None</span>
      )}
      {onMarkReviewed && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onMarkReviewed}
        >
          Mark reviewed
        </Button>
      )}
    </>
  );
}
