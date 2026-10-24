import { Link, useParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { MODES, RECORDABLE_MODES } from './modes';
import { GateNote, ScreenHeader } from './gateUi';

/** "Record Entry" / "Record Exit": choose the record type, then verify. */
export function RecordChooser() {
  const action = useParams().action?.toUpperCase() === 'EXIT' ? 'EXIT' : 'ENTRY';
  const entry = action === 'ENTRY';
  return (
    <>
      <ScreenHeader title={entry ? 'Record entry' : 'Record exit'} subtitle="Step 1 of 3 — choose the record type. Every movement is verified first." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {RECORDABLE_MODES.map((m) => {
          const info = MODES[m];
          return (
            <Link
              key={m}
              to={`/gate/verify/${m.toLowerCase()}?action=${action}`}
              className="flex min-h-32 flex-col justify-between rounded-2xl border border-white/10 bg-forest-900 p-4 transition-colors hover:border-gold-400/60 hover:bg-forest-800"
            >
              <info.icon className="size-8 text-gold-400" aria-hidden />
              <span className="mt-3 text-lg font-semibold text-white">{info.short}</span>
            </Link>
          );
        })}
      </div>
      <div className="mt-5">
        <GateNote>
          <span className="inline-flex items-center gap-1.5 font-semibold text-white">
            {entry ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
            {entry ? 'Entry only.' : 'Exit only.'}
          </span>{' '}
          If the record's current status does not allow this movement, the screen explains why instead of recording it.
        </GateNote>
      </div>
    </>
  );
}
