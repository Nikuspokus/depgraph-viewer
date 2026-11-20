import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UsersRepository } from './users.repository';
import { AuthService } from '../auth/auth.service';
import { ReferencedService } from './referenced.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    @Inject(forwardRef(() => AuthService)) private readonly auth: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}
  other() { return this.moduleRef.get(ReferencedService); }
}
