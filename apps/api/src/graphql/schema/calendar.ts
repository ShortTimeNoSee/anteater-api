export const calendarSchema = `#graphql
type CalendarTermHoliday {
    name: String!
    startDate: String!
    endDate: String!
}

type CalendarTerm @cacheControl(maxAge: 86400) {
    year: String!
    quarter: Term!
    instructionStart: String!
    instructionEnd: String!
    finalsStart: String!
    finalsEnd: String!
    socAvailable: String!
    holidays: [CalendarTermHoliday!]!
}

extend type Query {
    calendarTerm(year: String!, quarter: Term!): CalendarTerm!
    allCalendarTerms: [CalendarTerm!]!
}
`;
