import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceControllerBindingRepository,
  type VoiceControllerBindingRepositoryShape,
} from "../Services/VoiceControllerBindings.ts";
import { VoiceControllerBinding } from "../VoiceControlModels.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

const makeVoiceControllerBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByEnvironmentId = SqlSchema.findOneOption({
    Request: VoiceControllerBinding.fields.environmentId,
    Result: VoiceControllerBinding,
    execute: (environmentId) =>
      sql`
        SELECT
          environment_id AS "environmentId",
          controller_thread_id AS "controllerThreadId",
          active_target_thread_id AS "activeTargetThreadId",
          host_project_id AS "hostProjectId",
          provider_instance_id AS "providerInstanceId",
          authorized_runtime_ceiling AS "authorizedRuntimeCeiling",
          binding_generation AS "bindingGeneration",
          control_epoch AS "controlEpoch",
          state,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM voice_controller_bindings
        WHERE environment_id = ${environmentId}
      `,
  });

  const findByControllerThreadId = SqlSchema.findOneOption({
    Request: VoiceControllerBinding.fields.controllerThreadId,
    Result: VoiceControllerBinding,
    execute: (controllerThreadId) =>
      sql`
        SELECT
          environment_id AS "environmentId",
          controller_thread_id AS "controllerThreadId",
          active_target_thread_id AS "activeTargetThreadId",
          host_project_id AS "hostProjectId",
          provider_instance_id AS "providerInstanceId",
          authorized_runtime_ceiling AS "authorizedRuntimeCeiling",
          binding_generation AS "bindingGeneration",
          control_epoch AS "controlEpoch",
          state,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM voice_controller_bindings
        WHERE controller_thread_id = ${controllerThreadId}
      `,
  });

  const reserve: VoiceControllerBindingRepositoryShape["reserve"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findByEnvironmentId(input.environmentId);
          if (Option.isSome(existing)) {
            const binding = existing.value;
            return binding.state !== "resetting" &&
              binding.controllerThreadId === input.controllerThreadId &&
              binding.hostProjectId === input.hostProjectId &&
              binding.providerInstanceId === input.providerInstanceId &&
              binding.authorizedRuntimeCeiling === input.authorizedRuntimeCeiling
              ? ({ _tag: "existing", binding } as const)
              : ({ _tag: "conflict", binding } as const);
          }

          const controllerThreadCollision = yield* findByControllerThreadId(
            input.controllerThreadId,
          );
          if (Option.isSome(controllerThreadCollision)) {
            return {
              _tag: "conflict",
              binding: controllerThreadCollision.value,
            } as const;
          }

          const generationRows = yield* sql<{ readonly bindingGeneration: number }>`
            INSERT INTO voice_controller_binding_generations (
              environment_id,
              last_generation,
              updated_at
            )
            VALUES (
              ${input.environmentId},
              ${input.bindingGeneration},
              ${input.createdAt}
            )
            ON CONFLICT (environment_id)
            DO UPDATE SET
              last_generation = CASE
                WHEN voice_controller_binding_generations.last_generation >=
                  excluded.last_generation
                THEN voice_controller_binding_generations.last_generation + 1
                ELSE excluded.last_generation
              END,
              updated_at = excluded.updated_at
            RETURNING last_generation AS "bindingGeneration"
          `;
          const bindingGeneration = generationRows[0]?.bindingGeneration;
          if (bindingGeneration === undefined) {
            return yield* new PersistenceSqlError({
              operation: "VoiceControllerBindingRepository.reserve",
              detail: "Failed to allocate a binding generation.",
            });
          }

          yield* sql`
            INSERT OR IGNORE INTO voice_controller_bindings (
              environment_id,
              controller_thread_id,
              host_project_id,
              provider_instance_id,
              authorized_runtime_ceiling,
              binding_generation,
              control_epoch,
              state,
              created_at,
              updated_at
            )
            VALUES (
              ${input.environmentId},
              ${input.controllerThreadId},
              ${input.hostProjectId},
              ${input.providerInstanceId},
              ${input.authorizedRuntimeCeiling},
              ${bindingGeneration},
              ${input.controlEpoch},
              'provisioning',
              ${input.createdAt},
              ${input.createdAt}
            )
          `;

          const byEnvironment = yield* findByEnvironmentId(input.environmentId);
          const binding = Option.isSome(byEnvironment)
            ? byEnvironment.value
            : Option.getOrNull(yield* findByControllerThreadId(input.controllerThreadId));
          if (binding === null) {
            return yield* new PersistenceSqlError({
              operation: "VoiceControllerBindingRepository.reserve",
              detail: "Reservation was neither inserted nor recoverable.",
            });
          }

          if (
            binding.environmentId !== input.environmentId ||
            binding.controllerThreadId !== input.controllerThreadId ||
            binding.hostProjectId !== input.hostProjectId ||
            binding.providerInstanceId !== input.providerInstanceId ||
            binding.authorizedRuntimeCeiling !== input.authorizedRuntimeCeiling
          ) {
            return { _tag: "conflict", binding } as const;
          }

          return { _tag: "created", binding } as const;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isPersistenceSqlError(cause)
            ? cause
            : toPersistenceSqlError("VoiceControllerBindingRepository.reserve:transaction")(cause),
        ),
      );

  const getByEnvironmentId: VoiceControllerBindingRepositoryShape["getByEnvironmentId"] = (
    environmentId,
  ) =>
    findByEnvironmentId(environmentId).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerBindingRepository.getByEnvironmentId:query"),
      ),
    );

  const getByControllerThreadId: VoiceControllerBindingRepositoryShape["getByControllerThreadId"] =
    (controllerThreadId) =>
      findByControllerThreadId(controllerThreadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerBindingRepository.getByControllerThreadId:query"),
        ),
      );

  const compareAndSetState: VoiceControllerBindingRepositoryShape["compareAndSetState"] = (input) =>
    sql`
      UPDATE voice_controller_bindings
      SET state = ${input.nextState}, updated_at = ${input.updatedAt}
      WHERE environment_id = ${input.environmentId}
        AND controller_thread_id = ${input.expectedControllerThreadId}
        AND binding_generation = ${input.expectedBindingGeneration}
        AND state = ${input.expectedState}
        AND control_epoch = ${input.expectedControlEpoch}
      RETURNING environment_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerBindingRepository.compareAndSetState:query"),
      ),
    );

  const rotateControlEpoch: VoiceControllerBindingRepositoryShape["rotateControlEpoch"] = (input) =>
    input.nextControlEpoch <= input.expectedControlEpoch
      ? Effect.succeed(false)
      : sql`
          UPDATE voice_controller_bindings
          SET control_epoch = ${input.nextControlEpoch}, updated_at = ${input.updatedAt}
          WHERE environment_id = ${input.environmentId}
            AND control_epoch = ${input.expectedControlEpoch}
          RETURNING environment_id
        `.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(
            toPersistenceSqlError("VoiceControllerBindingRepository.rotateControlEpoch:query"),
          ),
        );

  const incrementControlEpoch: VoiceControllerBindingRepositoryShape["incrementControlEpoch"] = (
    input,
  ) =>
    sql`
      UPDATE voice_controller_bindings
      SET control_epoch = control_epoch + 1, updated_at = ${input.updatedAt}
      WHERE environment_id = ${input.environmentId}
        AND control_epoch = ${input.expectedControlEpoch}
      RETURNING control_epoch AS "controlEpoch"
    `.pipe(
      Effect.map((rows) =>
        rows.length === 1
          ? { _tag: "incremented" as const, controlEpoch: Number(rows[0]!.controlEpoch) }
          : { _tag: "conflict" as const },
      ),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerBindingRepository.incrementControlEpoch:query"),
      ),
    );

  const setActiveTarget: VoiceControllerBindingRepositoryShape["setActiveTarget"] = (input) =>
    sql`
      UPDATE voice_controller_bindings
      SET
        active_target_thread_id = ${input.activeTargetThreadId},
        updated_at = ${input.updatedAt}
      WHERE environment_id = ${input.environmentId}
        AND controller_thread_id = ${input.controllerThreadId}
        AND control_epoch = ${input.expectedControlEpoch}
        AND state IN ('active', 'dormant')
      RETURNING environment_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerBindingRepository.setActiveTarget:query"),
      ),
    );

  const clearActiveTargetIfMatches: VoiceControllerBindingRepositoryShape["clearActiveTargetIfMatches"] =
    (input) =>
      sql`
        UPDATE voice_controller_bindings
        SET
          active_target_thread_id = NULL,
          updated_at = ${input.updatedAt}
        WHERE environment_id = ${input.environmentId}
          AND controller_thread_id = ${input.controllerThreadId}
          AND control_epoch = ${input.expectedControlEpoch}
          AND state = 'active'
          AND active_target_thread_id = ${input.expectedActiveTargetThreadId}
        RETURNING environment_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerBindingRepository.clearActiveTargetIfMatches:query",
          ),
        ),
      );

  const deleteResetting: VoiceControllerBindingRepositoryShape["deleteResetting"] = (input) =>
    sql`
      DELETE FROM voice_controller_bindings
      WHERE environment_id = ${input.environmentId}
        AND controller_thread_id = ${input.expectedControllerThreadId}
        AND binding_generation = ${input.expectedBindingGeneration}
        AND state = 'resetting'
      RETURNING environment_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerBindingRepository.deleteResetting:query"),
      ),
    );

  return VoiceControllerBindingRepository.of({
    reserve,
    getByEnvironmentId,
    getByControllerThreadId,
    compareAndSetState,
    rotateControlEpoch,
    incrementControlEpoch,
    setActiveTarget,
    clearActiveTargetIfMatches,
    deleteResetting,
  });
});

export const VoiceControllerBindingRepositoryLive = Layer.effect(
  VoiceControllerBindingRepository,
  makeVoiceControllerBindingRepository,
);
