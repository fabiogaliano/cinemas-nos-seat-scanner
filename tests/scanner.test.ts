import { describe, expect, it } from "vitest";
import { cinemasFromSchedule } from "../src/server/scanner";

describe("cinemasFromSchedule", () => {
  it("deduplicates cinemas and formats across schedule days", () => {
    const schedule = {
      days: [
        {
          name: "Hoje",
          theaters: [{
            name: "Cinemas NOS Évora Plaza",
            regionId: "b96ae19e-81ce-4b04-a2c8-0563dffe910d",
            sessions: [{ uuid: "one", time: "20:00", format: "2d" }],
          }],
        },
        {
          name: "Amanhã",
          theaters: [{
            name: "Cinemas NOS Évora Plaza",
            regionId: "b96ae19e-81ce-4b04-a2c8-0563dffe910d",
            sessions: [
              { uuid: "two", time: "18:00", format: "2d" },
              { uuid: "three", time: "21:00", format: "imax" },
            ],
          }],
        },
      ],
    };

    expect(cinemasFromSchedule(schedule)).toEqual([{
      name: "Cinemas NOS Évora Plaza",
      region: "Sul",
      formats: ["2d", "imax"],
    }]);
  });
});
