\copy origin_types FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - OriginTypes.csv' WITH (FORMAT csv, HEADER true);

\copy survey_recommendation_buckets FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - SurveyRecommendationBuckets.csv' WITH (FORMAT csv, HEADER true);

\copy participants FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Participants.csv' WITH (FORMAT csv, HEADER true);

\copy events FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Events.csv' WITH (FORMAT csv, HEADER true);

\copy event_details FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - EventDetails.csv' WITH (FORMAT csv, HEADER true);

\copy donations FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Donations.csv' WITH (FORMAT csv, HEADER true, NULL 'null');

\copy milestones FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Milestones.csv' WITH (FORMAT csv, HEADER true);

\copy registrations FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Registrations.csv' WITH (FORMAT csv, HEADER true);

\copy surveys FROM 'C:\Users\casey\Documents\OneDrive\IS jr\Intex\Intex\EllaRisesData.xlsx - Surveys.csv' WITH (FORMAT csv, HEADER true, NULL '#REF!');
