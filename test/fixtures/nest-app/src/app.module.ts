import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';

@Module({
  imports: [UsersModule, AuthModule],
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
export class AppModule {}
