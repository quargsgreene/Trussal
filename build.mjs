import 'dotenv/config';
import esbuild from 'esbuild';

esbuild.build({
	entryPoints: ['src/index.js'],
	outfile: 'dist/custom-config.js',
	bundle: true,
	define: {
		'process.env.JAMULUS_HOST':JSON.stringify(process.env.JAMULUS_HOST || 'jamulus.example.com')
	}
});
