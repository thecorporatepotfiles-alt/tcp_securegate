import { BadgeCheck, CarFront, HardHat, KeyRound, Package, QrCode, type LucideIcon } from 'lucide-react';
import type { GateMode } from '../../../shared/constants';

export interface ModeInfo {
  mode: GateMode;
  title: string;
  short: string;
  instruction: string;
  inputLabel: string;
  placeholder: string;
  icon: LucideIcon;
  camera: boolean;
  keypad: boolean;
  uppercase: boolean;
}

export const MODES: Record<GateMode, ModeInfo> = {
  PERSONNEL: {
    mode: 'PERSONNEL',
    title: 'Verify personnel',
    short: 'Personnel',
    instruction: 'Tap the card on the mock reader, or enter the credential number printed on the card.',
    inputLabel: 'Credential number',
    placeholder: 'e.g. RF-8F3A21C4',
    icon: BadgeCheck,
    camera: false,
    keypad: true,
    uppercase: true,
  },
  VISITOR: {
    mode: 'VISITOR',
    title: 'Scan visitor QR',
    short: 'Visitor',
    instruction: 'Scan the QR on the visitor pass. If the code will not scan, enter the visit reference printed on the pass.',
    inputLabel: 'Visit reference or pass code',
    placeholder: 'e.g. VR-2026-00042',
    icon: QrCode,
    camera: true,
    keypad: false,
    uppercase: false,
  },
  CONTRACTOR: {
    mode: 'CONTRACTOR',
    title: 'Verify contractor',
    short: 'Contractor / vendor',
    instruction: 'Scan the contractor QR pass, tap their card, or enter the contractor reference.',
    inputLabel: 'Contractor reference, card number or pass code',
    placeholder: 'e.g. CW-2026-00007',
    icon: HardHat,
    camera: true,
    keypad: false,
    uppercase: false,
  },
  TEMPORARY: {
    mode: 'TEMPORARY',
    title: 'Verify temporary access',
    short: 'Temporary access',
    instruction: 'Scan the temporary access QR or enter the TA reference.',
    inputLabel: 'Temporary access reference or pass code',
    placeholder: 'e.g. TA-2026-00003',
    icon: KeyRound,
    camera: true,
    keypad: false,
    uppercase: false,
  },
  VEHICLE: {
    mode: 'VEHICLE',
    title: 'Vehicle entry & exit',
    short: 'Vehicle',
    instruction: 'Enter the registration number shown on the plate. No automatic number-plate recognition is used.',
    inputLabel: 'Registration number',
    placeholder: 'e.g. DM 21 AX 4821',
    icon: CarFront,
    camera: false,
    keypad: false,
    uppercase: true,
  },
  DELIVERY: {
    mode: 'DELIVERY',
    title: 'Delivery personnel',
    short: 'Delivery personnel',
    instruction: 'Enter the delivery reference to verify the courier for entry or exit.',
    inputLabel: 'Delivery reference',
    placeholder: 'e.g. DL-2026-00012',
    icon: Package,
    camera: false,
    keypad: false,
    uppercase: true,
  },
};

export const RECORDABLE_MODES: GateMode[] = ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'TEMPORARY', 'VEHICLE', 'DELIVERY'];

export function isGateMode(v: string | undefined): v is GateMode {
  return !!v && v in MODES;
}
