import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { ReportView } from '../components/oversight/ReportView';

export default function ReportViewPage() {
  const key = String(useParams().key);
  return (
    <ReportView
      key={key}
      reportKey={key}
      header={(def, actions) => <PageHeader back={{ to: '/reports', label: 'All reports' }} eyebrow={def?.group ?? 'Report'} title={def?.title ?? 'Report'} subtitle={def?.description} actions={actions} />}
    />
  );
}
