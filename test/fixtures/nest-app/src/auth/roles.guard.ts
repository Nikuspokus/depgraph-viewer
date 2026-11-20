import { Injectable, CanActivate } from '@nestjs/common';

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
