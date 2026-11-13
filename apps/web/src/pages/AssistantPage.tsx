import { Link } from "@tanstack/react-router";
import { AssistantPanel } from "@/components/AssistantPanel";
import { PageHeader } from "@/components/PageHeader";
import { useAppData } from "@/lib/queries";

/**
 * Full-page assistant (URL-addressable). Reuses AssistantPanel, so the
 * conversation list, streaming, proposal cards, and the honest AI-off copy
 * behave exactly like the side panel. Stream cleanup happens on unmount via
 * the panel's AbortController teardown.
 */
export function AssistantPage() {
  const { user } = useAppData();
  const isOwner = user?.role === "owner";

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <PageHeader
          eyebrow={<span className="label-caps">Owner only</span>}
          title="Assistant"
          description="The assistant uses the workspace owner's model connection and is not shared with member accounts in this release."
          actions={
            <Link to="/today" className="btn btn-secondary">
              Back to Today
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={<span className="label-caps">Optional</span>}
        title="Assistant"
        description="Proposes small plans; you approve every change. Morrow works fully with AI off."
        actions={
          <Link
            to="/settings"
            search={{ section: "ai" }}
            className="btn btn-secondary"
          >
            Settings → AI
          </Link>
        }
      />
      <div className="mt-6 h-[calc(100dvh-320px)] min-h-[480px] overflow-hidden rounded-md border border-hairline">
        <AssistantPanel />
      </div>
    </div>
  );
}
