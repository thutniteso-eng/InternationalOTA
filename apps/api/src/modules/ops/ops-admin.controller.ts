import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import {
  AuthGuard,
  CurrentPrincipal,
  type Principal,
  Roles,
  RolesGuard,
} from '../identity/index.js';
import { OpsService } from './ops.service.js';
import type {
  AdminDashboardDto,
  ReconciliationRunDetailDto,
  ReconciliationRunListResponse,
} from './ops.types.js';

@Controller('admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class OpsAdminController {
  constructor(private readonly opsService: OpsService) {}

  @Get('dashboard')
  async getDashboard(): Promise<AdminDashboardDto> {
    return this.opsService.getDashboard();
  }

  @Post('reconciliation/runs')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async runNow(
    @CurrentPrincipal() principal: Principal,
    @Body() body?: { reason?: string },
  ): Promise<ReconciliationRunDetailDto> {
    return this.opsService.triggerManualReconciliation(principal.userId, body?.reason);
  }

  @Get('reconciliation/runs')
  async listRuns(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ReconciliationRunListResponse> {
    return this.opsService.listReconciliationRuns({
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Get('reconciliation/runs/:id')
  async getRunDetail(@Param('id') id: string): Promise<ReconciliationRunDetailDto> {
    return this.opsService.getReconciliationRunDetail(id);
  }
}
