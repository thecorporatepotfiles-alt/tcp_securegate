import { Route, Routes } from 'react-router-dom';
import { DemoBanner } from '../components/layout/AppShell';
import { GateProvider, useGate } from './GateContext';
import { GateHeader } from './GateHeader';
import { GateHome } from './GateHome';
import { VerifyFlow } from './VerifyFlow';
import { RecordChooser } from './RecordChooser';
import { DeliveryFlow } from './DeliveryFlow';
import { WalkInFlow } from './WalkInFlow';
import { VisitorQueue } from './VisitorQueue';
import { RecentEvents } from './RecentEvents';
import { GateAlerts } from './GateAlerts';
import { MyReviews } from './MyReviews';
import { EmptyGate, ScreenHeader } from './gateUi';

function GateRoutes() {
  const { gateId } = useGate();
  if (gateId == null) {
    return <EmptyGate title="No gate available">Your account is not assigned to any active gate. Ask a location administrator to assign one.</EmptyGate>;
  }
  return (
    <Routes>
      <Route index element={<GateHome />} />
      <Route path="verify/:mode" element={<VerifyFlow />} />
      <Route path="record/:action" element={<RecordChooser />} />
      <Route path="deliveries" element={<DeliveryFlow />} />
      <Route path="walk-in" element={<WalkInFlow />} />
      <Route path="visitors" element={<VisitorQueue />} />
      <Route path="recent" element={<RecentEvents />} />
      <Route path="alerts" element={<GateAlerts />} />
      <Route path="reviews" element={<MyReviews />} />
      <Route
        path="*"
        element={
          <>
            <ScreenHeader title="Screen not found" />
            <EmptyGate title="This gate screen does not exist">Return to the gate home to continue.</EmptyGate>
          </>
        }
      />
    </Routes>
  );
}

/** Full-screen, touch-first gate interface for security operators. */
export default function GateApp() {
  return (
    <GateProvider>
      <div className="min-h-screen bg-forest-950 text-white [color-scheme:dark]">
        <DemoBanner />
        <GateHeader />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">
          <GateRoutes />
        </main>
      </div>
    </GateProvider>
  );
}
