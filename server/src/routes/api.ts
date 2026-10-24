import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { Ctx } from '../auth/context.js';
import { can, requirePerm, scopeIds } from '../auth/context.js';
import { forbidden, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/http.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { ctxOf, requireAuth, type AuthedRequest } from './middleware.js';
import * as personnel from '../services/personnel.js';
import * as visits from '../services/visits.js';
import * as verification from '../services/verification.js';
import * as movement from '../services/movement.js';
import * as vehicles from '../services/vehicles.js';
import * as deliveries from '../services/deliveries.js';
import * as contractors from '../services/contractors.js';
import * as alerts from '../services/alerts.js';
import * as exceptions from '../services/exceptions.js';
import * as dashboard from '../services/dashboard.js';
import * as reports from '../services/reports.js';
import * as admin from '../services/admin.js';
import * as gate from '../services/gate.js';
import * as notifications from '../services/notifications.js';
import { demoSamples } from '../services/demoSamples.js';
import { getSettings, updateSetting, SETTINGS_SCHEMA, SETTING_DESCRIPTIONS } from '../services/settings.js';
import { verifyAuditChain } from '../services/audit.js';
import { runScheduledChecks } from '../services/scheduler.js';
import { readerRegistry } from '../integrations/credentialReader.js';
import { resetDemo } from '../seed/demo.js';
import { audit } from '../services/audit.js';
import { likeParam } from '../lib/http.js';

type Handler = (ctx: Ctx, req: Request) => unknown | Promise<unknown>;

export function apiRoutes(db: DB, config: AppConfig, gateLimiter: RateLimiter): Router {
  const r = Router();
  r.use(requireAuth(db, config));

  const wrap = (fn: Handler) => async (req: Request, res: Response) => {
    const ctx = ctxOf(req as AuthedRequest, db, config);
    const out = await fn(ctx, req);
    res.json(out ?? { ok: true });
  };
  const get = (path: string, fn: Handler) => r.get(path, wrap(fn));
  const post = (path: string, fn: Handler) => r.post(path, wrap(fn));
  const patch = (path: string, fn: Handler) => r.patch(path, wrap(fn));
  const put = (path: string, fn: Handler) => r.put(path, wrap(fn));
  const locParam = (req: Request) => parse(z.object({ locationId: z.coerce.number().int().positive() }), req.query).locationId;

  // ---- Overview ------------------------------------------------------------
  get('/dashboard', (ctx, req) => dashboard.dashboardSummary(ctx, req.query));
  get('/presence', (ctx, req) => movement.listPresence(ctx, req.query));
  get('/events', (ctx, req) => movement.listRegister(ctx, req.query));
  get('/events/:id', (ctx, req) => movement.getEvent(ctx, idParam(req)));
  post('/events/:id/void', (ctx, req) => movement.voidEvent(ctx, idParam(req), req.body));
  post('/corrections/missing-event', (ctx, req) => movement.recordMissingEvent(ctx, req.body));

  // ---- Gate operations -----------------------------------------------------
  const gateLimit = gateLimiter.middleware((req) => `gate:${(req as AuthedRequest).actor.userId}`, 'Too many verification requests. Please slow down.');
  r.post('/gate/verify', gateLimit, wrap((ctx, req) => verification.verify(ctx, req.body)));
  r.post('/gate/events', gateLimit, wrap((ctx, req) => movement.recordMovement(ctx, req.body)));
  get('/gate/:gateId/home', (ctx, req) => gate.gateHome(ctx, idParam(req, 'gateId')));
  get('/gate/:gateId/recent', (ctx, req) => gate.gateRecent(ctx, idParam(req, 'gateId')));
  get('/gate/:gateId/visitors', (ctx, req) => visits.gateVisitorQueue(ctx, idParam(req, 'gateId')));
  get('/gate/:gateId/deliveries', (ctx, req) => deliveries.gateDeliveryQueue(ctx, idParam(req, 'gateId')));
  get('/gate/:gateId/hosts', (ctx, req) => {
    requirePerm(ctx.actor, 'gate.operate');
    const g = verification.loadGate(ctx, idParam(req, 'gateId'));
    return visits.eligibleApprovers(ctx, g.location_id);
  });
  get('/gate/:gateId/recipients', (ctx, req) => {
    requirePerm(ctx.actor, 'gate.operate');
    const g = verification.loadGate(ctx, idParam(req, 'gateId'));
    return deliveries.deliveryRecipients(ctx, g.location_id);
  });
  get('/gate/:gateId/demo-samples', (ctx, req) => demoSamples(ctx, idParam(req, 'gateId')));
  get('/gate/:gateId/alerts', (ctx, req) => {
    const g = verification.loadGate(ctx, idParam(req, 'gateId'));
    return alerts.listAlerts(ctx, { ...req.query, locationId: g.location_id, statusGroup: 'UNRESOLVED', pageSize: 50 });
  });
  post('/gate/visits/:id/arrive', (ctx, req) => visits.markArrived(ctx, idParam(req), req.body));
  post('/gate/walk-in', (ctx, req) => visits.registerWalkIn(ctx, req.body));
  post('/gate/deliveries', (ctx, req) => deliveries.createDelivery(ctx, { ...req.body, arrivedNow: true }));
  post('/gate/deliveries/:id/arrive', (ctx, req) => deliveries.recordDeliveryArrival(ctx, idParam(req), req.body));
  post('/gate/deliveries/:id/depart', (ctx, req) => deliveries.recordDeliveryDeparture(ctx, idParam(req), req.body));
  post('/gate/vehicles', (ctx, req) => vehicles.gateRegisterVehicle(ctx, req.body));
  post('/gate/manual-reviews', (ctx, req) => verification.requestManualReview(ctx, req.body));
  get('/manual-reviews', (ctx, req) => verification.listManualReviews(ctx, req.query));
  get('/manual-reviews/:id', (ctx, req) => verification.getManualReview(ctx, idParam(req)));
  post('/manual-reviews/:id/decide', (ctx, req) => verification.decideManualReview(ctx, idParam(req), req.body));

  // ---- Personnel & credentials ---------------------------------------------
  get('/personnel', (ctx, req) => personnel.listPersonnel(ctx, req.query));
  get('/personnel/units', (ctx) => personnel.listUnits(ctx));
  post('/personnel', (ctx, req) => personnel.createPersonnel(ctx, req.body));
  get('/personnel/:id', (ctx, req) => personnel.getPersonnel(ctx, idParam(req)));
  patch('/personnel/:id', (ctx, req) => personnel.updatePersonnel(ctx, idParam(req), req.body));
  post('/personnel/:id/status', (ctx, req) => personnel.setPersonnelStatus(ctx, idParam(req), req.body));
  get('/credentials', (ctx, req) => personnel.listCredentials(ctx, req.query));
  post('/credentials', (ctx, req) => personnel.assignCredential(ctx, req.body));
  get('/credentials/:id', (ctx, req) => personnel.getCredential(ctx, idParam(req)));
  post('/credentials/:id/status', (ctx, req) => personnel.changeCredentialStatus(ctx, idParam(req), req.body));
  post('/credentials/:id/replace', (ctx, req) => personnel.replaceCredential(ctx, idParam(req), req.body));

  // ---- Visitors --------------------------------------------------------------
  get('/visits', (ctx, req) => visits.listVisits(ctx, req.query));
  get('/visits/waiting-list', (ctx, req) => visits.waitingList(ctx, req.query));
  post('/visits', (ctx, req) => visits.createVisit(ctx, req.body));
  get('/visits/:id', (ctx, req) => visits.getVisit(ctx, idParam(req)));
  get('/visits/:id/pass', (ctx, req) => visits.getPassView(ctx, idParam(req)));
  post('/visits/:id/approve', (ctx, req) => visits.approveVisit(ctx, idParam(req), req.body));
  post('/visits/:id/reject', (ctx, req) => visits.rejectVisit(ctx, idParam(req), req.body));
  post('/visits/:id/security-check', (ctx, req) => visits.completeSecurityCheck(ctx, idParam(req), req.body));
  post('/visits/:id/cancel', (ctx, req) => visits.cancelVisit(ctx, idParam(req), req.body));
  post('/visits/:id/acknowledge', (ctx, req) => visits.acknowledgeArrival(ctx, idParam(req)));

  // ---- Contractors & temporary access ----------------------------------------
  get('/contractor-companies', (ctx, req) => contractors.listCompanies(ctx, req.query));
  post('/contractor-companies', (ctx, req) => contractors.createCompany(ctx, req.body));
  patch('/contractor-companies/:id', (ctx, req) => contractors.updateCompany(ctx, idParam(req), req.body));
  get('/contractors', (ctx, req) => contractors.listContractors(ctx, req.query));
  post('/contractors', (ctx, req) => contractors.createContractor(ctx, req.body));
  get('/contractors/:id', (ctx, req) => contractors.getContractor(ctx, idParam(req)));
  patch('/contractors/:id', (ctx, req) => contractors.updateContractor(ctx, idParam(req), req.body));
  get('/contractors/:id/pass', (ctx, req) => contractors.contractorPass(ctx, idParam(req)));
  post('/contractors/:id/pass/reissue', (ctx, req) => contractors.rotateContractorPass(ctx, idParam(req)));
  get('/temporary-access', (ctx, req) => contractors.listTemporaryAccess(ctx, req.query));
  post('/temporary-access', (ctx, req) => contractors.createTemporaryAccess(ctx, req.body));
  get('/temporary-access/:id', (ctx, req) => contractors.getTemporaryAccess(ctx, idParam(req)));
  get('/temporary-access/:id/pass', (ctx, req) => contractors.temporaryAccessPass(ctx, idParam(req)));
  post('/temporary-access/:id/revoke', (ctx, req) => contractors.revokeTemporaryAccess(ctx, idParam(req), req.body));

  // ---- Vehicles & deliveries -------------------------------------------------
  get('/vehicles', (ctx, req) => vehicles.listVehicles(ctx, req.query));
  post('/vehicles', (ctx, req) => vehicles.createVehicle(ctx, req.body));
  get('/vehicles/:id', (ctx, req) => vehicles.getVehicle(ctx, idParam(req)));
  patch('/vehicles/:id', (ctx, req) => vehicles.updateVehicle(ctx, idParam(req), req.body));
  get('/deliveries', (ctx, req) => deliveries.listDeliveries(ctx, req.query));
  post('/deliveries', (ctx, req) => deliveries.createDelivery(ctx, req.body));
  get('/deliveries/:id', (ctx, req) => deliveries.getDelivery(ctx, idParam(req)));
  post('/deliveries/:id/authorize', (ctx, req) => deliveries.authorizeDelivery(ctx, idParam(req), req.body));
  post('/deliveries/:id/reject', (ctx, req) => deliveries.rejectDelivery(ctx, idParam(req), req.body));
  post('/deliveries/:id/cancel', (ctx, req) => deliveries.cancelDelivery(ctx, idParam(req), req.body));
  post('/deliveries/:id/acknowledge', (ctx, req) => deliveries.acknowledgeReceipt(ctx, idParam(req), req.body));

  // ---- Alerts, exceptions & handover -----------------------------------------
  get('/alerts', (ctx, req) => alerts.listAlerts(ctx, req.query));
  get('/alerts/:id', (ctx, req) => alerts.getAlert(ctx, idParam(req)));
  post('/alerts/:id/acknowledge', (ctx, req) => alerts.acknowledgeAlert(ctx, idParam(req), req.body));
  post('/alerts/:id/resolve', (ctx, req) => alerts.resolveAlert(ctx, idParam(req), req.body));
  get('/exceptions', (ctx, req) => exceptions.listExceptions(ctx, req.query));
  post('/exceptions', (ctx, req) => exceptions.createException(ctx, req.body));
  get('/exceptions/:id', (ctx, req) => exceptions.getException(ctx, idParam(req)));
  post('/exceptions/:id/status', (ctx, req) => exceptions.changeExceptionStatus(ctx, idParam(req), req.body));
  post('/exceptions/:id/assign', (ctx, req) => exceptions.assignException(ctx, idParam(req), req.body));
  get('/handover/summary', (ctx, req) => exceptions.handoverSummary(ctx, locParam(req)));
  get('/handovers', (ctx, req) => exceptions.listHandovers(ctx, req.query));
  post('/handovers', (ctx, req) => exceptions.recordHandover(ctx, req.body));
  post('/handovers/:id/acknowledge', (ctx, req) => exceptions.acknowledgeHandover(ctx, idParam(req)));

  // ---- Reports & audit -------------------------------------------------------
  get('/reports', (ctx) => reports.listReportDefinitions(ctx));
  get('/reports/:key', (ctx, req) => reports.runReport(ctx, String(req.params.key), req.query));
  r.get('/reports/:key/export', (req, res) => {
    const ctx = ctxOf(req as unknown as AuthedRequest, db, config);
    const out = reports.exportReportCsv(ctx, String(req.params.key), req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Row-Count', String(out.rows));
    res.send(out.csv);
  });
  get('/audit/record', (ctx, req) => {
    requirePerm(ctx.actor, 'audit.view');
    const q = parse(z.object({ entityType: z.string().max(40), entityId: z.string().max(40) }), req.query);
    const ids = ctx.actor.locationIds;
    return ctx.db
      .prepare(
        `SELECT id, created_at AS createdAt, actor_username AS actor, actor_role AS actorRole, action, outcome, metadata
         FROM audit_events WHERE organization_id = ? AND entity_type = ? AND entity_id = ?
         AND (${ctx.actor.allLocations ? 'location_id IS NULL OR ' : ''}location_id IN (${ids.map(() => '?').join(',') || 'NULL'})) ORDER BY id DESC LIMIT 100`,
      )
      .all(ctx.actor.orgId, q.entityType, q.entityId, ...ids);
  });
  get('/audit/verify', (ctx) => {
    requirePerm(ctx.actor, 'audit.view');
    return verifyAuditChain(ctx.db);
  });

  // ---- Notifications ---------------------------------------------------------
  get('/notifications', (ctx, req) =>
    notifications.listNotifications(ctx, parse(z.object({ unreadOnly: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query)),
  );
  post('/notifications/read-all', (ctx) => ({ updated: notifications.markAllNotificationsRead(ctx) }));
  post('/notifications/:id/read', (ctx, req) => notifications.markNotificationRead(ctx, idParam(req)));

  // ---- Lookups ---------------------------------------------------------------
  get('/lookups/approvers', (ctx, req) => visits.eligibleApprovers(ctx, locParam(req)));
  get('/lookups/hosts', (ctx, req) => visits.eligibleHosts(ctx, locParam(req)));
  get('/lookups/recipients', (ctx, req) => deliveries.deliveryRecipients(ctx, locParam(req)));
  get('/lookups/personnel', (ctx, req) => personnel.lookupPersonnel(ctx, String(req.query.q ?? '')));
  get('/lookups/visitors', (ctx, req) => visits.searchVisitors(ctx, String(req.query.q ?? '')));
  get('/lookups/contractors', (ctx, req) => {
    requirePerm(ctx.actor, 'contractors.view', 'temp_access.manage', 'vehicles.manage');
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return [];
    const ids = ctx.actor.locationIds;
    return ctx.db
      .prepare(
        `SELECT c.id, c.reference, c.full_name AS name, cc.name AS company, c.status FROM contractors c JOIN contractor_companies cc ON cc.id = c.company_id
         WHERE c.organization_id = ? AND c.location_id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND (c.full_name LIKE ? ESCAPE '\\' OR c.reference LIKE ? ESCAPE '\\')
         ORDER BY c.full_name LIMIT 10`,
      )
      .all(ctx.actor.orgId, ...ids, likeParam(q), likeParam(q));
  });
  get('/lookups/users', (ctx, req) => {
    requirePerm(ctx.actor, 'exceptions.manage', 'handover.manage');
    const locationId = locParam(req);
    scopeIds(ctx.actor, locationId);
    return ctx.db
      .prepare(
        `SELECT u.id, u.display_name AS name, u.role_code AS role FROM users u
         WHERE u.organization_id = ? AND u.is_active = 1 AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
         ORDER BY u.display_name`,
      )
      .all(ctx.actor.orgId, locationId);
  });

  // ---- Administration --------------------------------------------------------
  get('/admin/users', (ctx, req) => admin.listUsers(ctx, req.query));
  post('/admin/users', (ctx, req) => admin.createUser(ctx, req.body));
  patch('/admin/users/:id', (ctx, req) => admin.updateUser(ctx, idParam(req), req.body));
  post('/admin/users/:id/password', (ctx, req) => admin.resetUserPassword(ctx, idParam(req), req.body));
  get('/admin/roles', (ctx) => admin.listRoles(ctx));
  put('/admin/roles/:role', (ctx, req) => admin.updateRolePermissions(ctx, String(req.params.role), req.body));
  get('/admin/locations', (ctx) => admin.listLocations(ctx));
  post('/admin/locations', (ctx, req) => admin.createLocation(ctx, req.body));
  patch('/admin/locations/:id', (ctx, req) => admin.updateLocation(ctx, idParam(req), req.body));
  post('/admin/gates', (ctx, req) => admin.createGate(ctx, req.body));
  patch('/admin/gates/:id', (ctx, req) => admin.updateGate(ctx, idParam(req), req.body));
  get('/admin/settings', (ctx) => {
    requirePerm(ctx.actor, 'settings.manage');
    const values = getSettings(ctx.db, ctx.actor.orgId);
    return Object.keys(SETTINGS_SCHEMA).map((key) => ({ key, value: values[key as keyof typeof values], description: SETTING_DESCRIPTIONS[key as keyof typeof SETTING_DESCRIPTIONS] }));
  });
  put('/admin/settings/:key', (ctx, req) => {
    updateSetting(ctx, String(req.params.key), req.body?.value);
    return { ok: true };
  });
  post('/admin/run-checks', (ctx) => {
    if (!can(ctx.actor, 'settings.manage') && !can(ctx.actor, 'alerts.resolve')) throw forbidden();
    const result = runScheduledChecks(ctx.db, ctx.config);
    audit(ctx, { action: 'system.run_checks', metadata: result as unknown as Record<string, unknown> });
    return result;
  });
  get('/integrations/readers', (ctx) => {
    requirePerm(ctx.actor, 'gate.operate', 'locations.manage', 'credentials.manage');
    const ids = ctx.actor.locationIds;
    const gates = ctx.db.prepare(`SELECT id, code, name FROM gates WHERE is_active = 1 AND location_id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids) as {
      id: number;
      code: string;
      name: string;
    }[];
    return readerRegistry(gates).map((a) => a.status());
  });
  post('/admin/demo/reset', (ctx) => {
    if (ctx.config.mode !== 'demo') throw notFound('Endpoint');
    requirePerm(ctx.actor, 'demo.reset');
    const summary = resetDemo(ctx.db, ctx.config, ctx.actor.username);
    return { ok: true, reloginRequired: true, summary };
  });

  return r;
}
