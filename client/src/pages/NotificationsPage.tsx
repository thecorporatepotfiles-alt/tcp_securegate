import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { useAction } from '../components/toast';
import { Button, Card, EmptyState, ErrorState, Notice, PageHeader, Spinner, cx } from '../components/ui';

export default function NotificationsPage() {
  const q = useQuery({ queryKey: ['notifications', 'page'], queryFn: () => api.get<{ items: Row[]; unread: number }>('/notifications', { limit: 100 }), refetchInterval: 30_000 });
  const readAll = useAction(() => api.post('/notifications/read-all'), { success: 'All notifications marked as read', invalidate: [['notifications']] });
  const readOne = useAction((id: number) => api.post(`/notifications/${id}/read`), { invalidate: [['notifications']] });
  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="In-app notifications for your role. Read status reflects only what you have opened here."
        actions={<Button icon={<CheckCheck className="size-4" />} onClick={() => readAll.mutate(undefined)} disabled={!q.data?.unread} loading={readAll.isPending}>Mark all as read</Button>}
      />
      <Notice tone="info" className="mb-4">
        Notifications are delivered in-app only. SecureGate does not send SMS or email in this prototype, and does not claim a message was seen unless you open it here.
      </Notice>
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.items.length === 0 ? (
          <EmptyState icon={<Bell className="size-5" />} title="No notifications" description="Approval requests, visitor arrivals and alerts for you will appear here." />
        ) : (
          <ul className="divide-y divide-line">
            {q.data!.items.map((n) => (
              <li key={n.id} className={cx('flex items-start gap-3 px-5 py-4', !n.readAt && 'bg-gold-100/30')}>
                <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-line-strong' : 'bg-gold-500')} aria-label={n.readAt ? 'Read' : 'Unread'} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink">{n.link ? <Link to={n.link} onClick={() => !n.readAt && readOne.mutate(n.id)} className="hover:text-forest-700">{n.title}</Link> : n.title}</div>
                  <div className="text-[13px] text-ink-2">{n.body}</div>
                  <div className="mt-1 text-xs text-ink-3">
                    Created {fmtDateTime(n.createdAt)} · {n.readAt ? `Opened ${fmtDateTime(n.readAt)}` : 'Not yet opened'}
                  </div>
                </div>
                {!n.readAt && (
                  <Button size="sm" variant="ghost" onClick={() => readOne.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
