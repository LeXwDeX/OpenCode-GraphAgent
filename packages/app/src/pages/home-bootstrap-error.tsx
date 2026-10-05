import { Button } from "@opencode-ai/ui/button"

export function HomeBootstrapError(props: {
  error: string
  retrying: boolean
  retryLabel: string
  loadingLabel: string
  onRetry: () => void
}) {
  return (
    <div
      class="mt-30 mx-auto flex max-w-xl flex-col items-center gap-3 text-center"
      role="alert"
      aria-busy={props.retrying}
    >
      <div class="text-14-medium text-text-strong">{props.error}</div>
      <Button
        data-action="home-bootstrap-retry"
        size="normal"
        variant="secondary"
        class="px-3"
        disabled={props.retrying}
        onClick={props.onRetry}
      >
        {props.retrying ? props.loadingLabel : props.retryLabel}
      </Button>
    </div>
  )
}
