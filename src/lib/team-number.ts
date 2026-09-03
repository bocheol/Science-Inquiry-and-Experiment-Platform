const MIN_TEAM_NUMBER = 1;
const MAX_TEAM_NUMBER = 20;

export function findNextAvailableTeamNumber(teamNumbers: Array<number | null | undefined>) {
  const used = new Set(
    teamNumbers.filter(
      (teamNumber): teamNumber is number =>
        typeof teamNumber === "number"
        && Number.isInteger(teamNumber)
        && teamNumber >= MIN_TEAM_NUMBER
        && teamNumber <= MAX_TEAM_NUMBER,
    ),
  );

  for (let teamNumber = MIN_TEAM_NUMBER; teamNumber <= MAX_TEAM_NUMBER; teamNumber += 1) {
    if (!used.has(teamNumber)) return teamNumber;
  }
  return null;
}
