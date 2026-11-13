import { useEffect } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { isApiError, isUnauthorized, proposalsApi } from "@/api";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ProposalCard } from "@/components/ProposalCard";
import { TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useAppData } from "@/lib/queries";

/**
 * Single proposal view (URL-addressable). The card itself owns keep/drop
 * checkboxes, Apply selected, Dismiss, and Undo; this page adds loading,
 * 404, and session-expired states around it. The sticky action footer is the
 * card's existing `sticky bottom-0` pattern, so it stays mobile-usable.
 */
export function ProposalPage() {
  const { proposalId } = useParams({ from: "/_app/proposal/$proposalId" });
  const navigate = useNavigate();
  const { user } = useAppData();
  const isOwner = user?.role === "owner";
  const query = useQuery({
    queryKey: ["proposal", proposalId],
    queryFn: () => proposalsApi.get(proposalId),
    staleTime: 10_000,
    // Proposals belong to the owner's assistant. Members who deep-link here
    // must not fire a guaranteed 403.
    enabled: isOwner,
    retry: (failureCount, error) => {
      if (isApiError(error) && error.status < 500) return false;
      return failureCount < 1;
    },
  });

  // apiFetch also fires the global session-expired event on 401; this is the
  // explicit route-guard half for a direct deep link.
  useEffect(() => {
    if (query.error && isUnauthorized(query.error)) {
      void navigate({ to: "/session-expired", replace: true });
    }
  }, [navigate, query.error]);

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <PageHeader
          eyebrow={<span className="label-caps">Owner only</span>}
          title="Proposal"
          description="Assistant proposals belong to the workspace owner and are not shared with member accounts."
          actions={
            <Link to="/today" className="btn btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to Today
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <TaskListSkeleton rows={3} />
      </div>
    );
  }

  const proposal = query.data?.proposal ?? null;
  if (!proposal) {
    const unauthorized = query.error && isUnauthorized(query.error);
    const missing =
      isApiError(query.error) &&
      (query.error.status === 404 || query.error.status === 410);
    if (unauthorized) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
          <PageHeader
            eyebrow="Proposal"
            title="Sign in to review"
            description="Your session expired. Nothing was changed."
            actions={
              <Link to="/session-expired" className="btn btn-primary">
                Session expired
              </Link>
            }
          />
        </div>
      );
    }
    if (missing || !query.isError) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
          <PageHeader
            eyebrow="Proposal"
            title="Proposal not found"
            description="It may have been dismissed, expired, or created on another device."
            actions={
              <Link to="/assistant" className="btn btn-secondary">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Assistant
              </Link>
            }
          />
          <div className="mt-8">
            <EmptyState
              icon={<FileQuestion className="h-5 w-5" aria-hidden="true" />}
              title="No proposal here."
              description="Ask the assistant for a fresh plan — nothing changes until you approve it."
            />
          </div>
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <PageHeader
          eyebrow="Proposal"
          title="Proposal didn’t load"
          description="Nothing on the server was changed."
          actions={
            <Link to="/assistant" className="btn btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Assistant
            </Link>
          }
        />
        <TaskListError
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={
          <span className="label-caps">
            Proposal · {proposal.status}
          </span>
        }
        title={proposal.summary}
        description="Nothing changes until you apply it. Keep or drop items below, then decide."
        actions={
          <Link to="/assistant" className="btn btn-secondary">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Assistant
          </Link>
        }
      />
      <div className="mt-5">
        <ProposalCard proposal={proposal} />
      </div>
      <p className="mt-6 text-12 leading-relaxed text-muted">
        The assistant is optional — lists, reminders, and push keep working
        with AI off.{" "}
        <Link
          to="/settings"
          search={{ section: "ai" }}
          className="font-semibold text-accent underline underline-offset-2"
        >
          Settings → AI
        </Link>
      </p>
    </div>
  );
}
